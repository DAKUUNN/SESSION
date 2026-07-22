//! Dropbox integration (Phase 2 MVP): PKCE OAuth connect/disconnect, and
//! browsing + importing files from the app's scoped Dropbox App Folder.
//!
//! Explicitly OUT of scope for this pass (deferred to a later phase):
//! continuous background sync, and an LRU/pin-based offline cache eviction
//! policy. What this module does provide: connect once, browse the app
//! folder, and download+import a chosen file as a "dropbox"-sourced Version
//! (cached locally so playback/waveform code never needs to know the
//! difference between a local and a Dropbox-sourced file).
//!
//! ## App credentials (public, not secret)
//! App Key: "0p4wy3rkh5d9yi6". Permission type: Scoped App (App Folder) — this
//! app can only ever see its own dedicated folder in the user's Dropbox, never
//! their full account. "Allow public clients (Implicit Grant & PKCE)" is set
//! to Allow in the Dropbox App Console, which is what makes the PKCE flow
//! below valid *without* an App Secret — a public client (this desktop app)
//! must never embed or receive the App Secret; don't add one, even if asked.
//!
//! ## Why the loopback redirect uses port 5173, not 1420
//! Three redirect URIs are registered in the Dropbox app: a `session://...`
//! custom scheme (for packaged/production builds, not implemented yet — needs
//! `tauri-plugin-deep-link` + platform URL-scheme registration, a separate
//! packaging-phase task), `http://127.0.0.1:1420/dropbox/callback`, and
//! `http://localhost:5173/dropbox/callback`. Port 1420 is Vite's dev server
//! (see ../vite.config.ts and tauri.conf.json's `devUrl`) — it's already bound
//! whenever this app is running in dev mode, so a second raw listener can't
//! also bind 1420. Port 5173 (Vite's *default*, unused port — this project
//! pins Vite to 1420 instead) is genuinely free, so `dropbox_connect` below
//! must bind its temporary one-shot HTTP listener there and use
//! `http://localhost:5173/dropbox/callback` as the `redirect_uri` in both the
//! authorize URL and the token exchange request. Do not use port 1420.
//!
//! ## Flow implemented by `dropbox_connect`
//! 1. Generate a PKCE `code_verifier` (a long random URL-safe string) and its
//!    `code_challenge` (base64url-no-pad of SHA-256(code_verifier)).
//! 2. Build the authorize URL:
//!    `https://www.dropbox.com/oauth2/authorize?client_id=0p4wy3rkh5d9yi6&response_type=code&code_challenge=<challenge>&code_challenge_method=S256&redirect_uri=http://localhost:5173/dropbox/callback&token_access_type=offline`
//!    (`token_access_type=offline` is required to get a refresh_token back —
//!    without it Dropbox only issues a short-lived access token with no way
//!    to renew it later.)
//! 3. Open that URL in the user's default system browser (this app already
//!    depends on `tauri-plugin-opener` — use whatever it exposes for opening
//!    an arbitrary URL; check its actual Rust API in the installed crate
//!    rather than assuming a method name).
//! 4. Simultaneously, bind a one-shot plain `std::net::TcpListener` on
//!    `127.0.0.1:5173`, accept exactly one connection, read the HTTP request
//!    line far enough to extract the `code` query parameter from something
//!    like `GET /dropbox/callback?code=XXXX HTTP/1.1`, write back a minimal
//!    `HTTP/1.1 200 OK` response with a small human-readable HTML body like
//!    "Connected to Dropbox — you can close this tab and return to Session.",
//!    then close the listener. No new HTTP-server crate is needed for this —
//!    a raw `TcpListener` + manual parsing of one request line is sufficient
//!    and keeps the dependency list small. Apply a reasonable timeout (e.g.
//!    ~3 minutes) so this doesn't hang forever if the user abandons the flow.
//! 5. Exchange the code for tokens: `POST https://api.dropboxapi.com/oauth2/token`
//!    with form fields `grant_type=authorization_code`, `code=<code>`,
//!    `client_id=0p4wy3rkh5d9yi6`, `code_verifier=<verifier>`,
//!    `redirect_uri=http://localhost:5173/dropbox/callback` (still no secret).
//!    Response JSON includes `access_token`, `expires_in` (seconds),
//!    `refresh_token`, `account_id`.
//! 6. Call `POST https://api.dropboxapi.com/2/users/get_current_account` with
//!    `Authorization: Bearer <access_token>` (empty JSON body `null`) to get
//!    the account's email + display name.
//! 7. Persist the refresh_token (and ideally the access_token + its computed
//!    expiry instant, to avoid refreshing on every single call) in the OS
//!    keychain via the `keyring` crate — service name
//!    `"com.peaksense.session"`, username/account `"dropbox"`. Never put any
//!    token in the SQLite database.
//! 8. Persist the non-secret account identity via
//!    `crate::db::save_dropbox_connection`.
//! 9. Return the `DropboxAccountInfo` to the frontend.
//!
//! ## Token refresh
//! Access tokens expire (~4h). Before any authenticated API call, check the
//! in-memory cached expiry (kept in `DropboxState`); if expired or absent,
//! POST to the same `/oauth2/token` endpoint with
//! `grant_type=refresh_token&refresh_token=<...>&client_id=0p4wy3rkh5d9yi6`
//! (again, no secret — PKCE-issued refresh tokens don't need one), update the
//! in-memory access token + expiry (and re-save the refresh token to the
//! keychain if Dropbox rotated it — check the response, only some OAuth
//! providers rotate refresh tokens on use).

use crate::models::{DropboxAccountInfo, DropboxFileEntry};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use parking_lot::Mutex;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::{Manager, State};

const APP_KEY: &str = "0p4wy3rkh5d9yi6";
const REDIRECT_URI: &str = "http://localhost:5173/dropbox/callback";
const CALLBACK_PORT: u16 = 5173;
const KEYCHAIN_SERVICE: &str = "com.peaksense.session";
const KEYCHAIN_ACCOUNT: &str = "dropbox";

/// How long `dropbox_connect` will wait for the browser round-trip before
/// giving up on an abandoned/botched flow.
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

/// Common audio file extensions eligible for import from the app folder,
/// matched case-insensitively against each entry's name.
const AUDIO_EXTENSIONS: [&str; 6] = ["mp3", "wav", "aiff", "flac", "m4a", "aac"];

/// In-memory access-token cache, populated on connect and refreshed on
/// demand. The refresh_token itself lives only in the OS keychain.
#[derive(Default)]
pub struct DropboxTokenCache {
    access_token: Option<String>,
    expires_at: Option<Instant>,
}

pub struct DropboxState(pub Mutex<DropboxTokenCache>);

// ---------- Dropbox API response shapes ----------

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(serde::Deserialize)]
struct CurrentAccountResponse {
    account_id: String,
    email: String,
    name: AccountName,
}

#[derive(serde::Deserialize)]
struct AccountName {
    display_name: String,
}

#[derive(serde::Deserialize)]
struct ListFolderResult {
    entries: Vec<DropboxMetadataEntry>,
    cursor: String,
    has_more: bool,
}

#[derive(serde::Deserialize)]
struct DropboxMetadataEntry {
    #[serde(rename = ".tag")]
    tag: String,
    name: String,
    #[serde(default)]
    path_lower: Option<String>,
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

// ---------- PKCE helpers ----------

/// Generates a cryptographically random PKCE `code_verifier` (base64url,
/// no padding, of 48 random bytes -> 64 characters) and its S256
/// `code_challenge` (base64url-no-pad of SHA-256(code_verifier)).
fn generate_pkce_pair() -> (String, String) {
    let mut random_bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(random_bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let digest = hasher.finalize();
    let code_challenge = URL_SAFE_NO_PAD.encode(digest);

    (code_verifier, code_challenge)
}

/// Percent-encodes a string for safe use as a single URL query parameter
/// value (RFC 3986 unreserved characters pass through unescaped).
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Minimal percent-decoder for query-string values (handles `%XX` escapes
/// and `+` as space). Sufficient for parsing the one loopback request we
/// read in `wait_for_oauth_callback`.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Blocks the calling thread (intended to run via `spawn_blocking`) until
/// exactly one connection arrives on `listener`, or `timeout` elapses.
/// Parses the `code` (or `error`/`error_description`) query parameter out
/// of the request line, replies with a minimal human-readable HTML page,
/// then lets the listener (and the one accepted connection) drop, closing
/// both.
fn wait_for_oauth_callback(listener: std::net::TcpListener, timeout: Duration) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to configure the Dropbox OAuth callback listener: {e}"))?;

    let deadline = Instant::now() + timeout;
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _addr)) => break stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(
                        "timed out waiting for the Dropbox OAuth callback — the browser flow \
                         was not completed within 3 minutes"
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(format!("failed to accept the Dropbox OAuth callback connection: {e}")),
        }
    };

    // The accepted stream's nonblocking state is not guaranteed to follow the
    // listener's across platforms — force blocking mode for a simple read/write.
    stream
        .set_nonblocking(false)
        .map_err(|e| format!("failed to configure the Dropbox OAuth callback connection: {e}"))?;

    let request_line = {
        use std::io::BufRead;
        let mut reader = std::io::BufReader::new(&stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("failed to read the Dropbox OAuth callback request: {e}"))?;
        line
    };

    let query = request_line
        .split_whitespace()
        .nth(1)
        .and_then(|target| target.split_once('?'))
        .map(|(_, query)| query)
        .unwrap_or("");

    let mut code: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = percent_decode(parts.next().unwrap_or(""));
        match key {
            "code" => code = Some(value),
            "error" => error = Some(value),
            "error_description" => error_description = Some(value),
            _ => {}
        }
    }

    let body_message = if code.is_some() {
        "Connected to Dropbox — you can close this tab and return to Session."
    } else {
        "Dropbox connection failed — you can close this tab and return to Session."
    };
    let body = format!(
        "<html><body style=\"font-family: -apple-system, sans-serif; text-align: center; padding-top: 4rem;\"><h2>{body_message}</h2></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    {
        use std::io::Write;
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }

    match code {
        Some(code) => Ok(code),
        None => {
            let message = error_description
                .or(error)
                .unwrap_or_else(|| "no authorization code was returned".to_string());
            Err(format!("Dropbox authorization failed: {message}"))
        }
    }
}

// ---------- Token refresh ----------

/// Ensures a valid (refreshing if necessary) Dropbox access token, used by
/// every authenticated API call after `dropbox_connect`. Checks the
/// in-memory cache first; if it's missing or close to expiry, reads the
/// refresh_token from the OS keychain and exchanges it for a fresh access
/// token, updating the cache (and the keychain, if Dropbox rotated the
/// refresh token) before returning.
async fn ensure_fresh_token(dropbox: &State<'_, DropboxState>) -> Result<String, String> {
    const EXPIRY_SAFETY_MARGIN: Duration = Duration::from_secs(60);

    {
        let cache = dropbox.0.lock();
        if let (Some(token), Some(expires_at)) = (cache.access_token.as_ref(), cache.expires_at) {
            if expires_at > Instant::now() + EXPIRY_SAFETY_MARGIN {
                return Ok(token.clone());
            }
        }
    }

    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("failed to access the OS keychain: {e}"))?;
    let refresh_token = match entry.get_password() {
        Ok(token) => token,
        Err(keyring::Error::NoEntry) => return Err("Dropbox is not connected".to_string()),
        Err(e) => return Err(format!("failed to read the Dropbox refresh token from the OS keychain: {e}")),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.dropboxapi.com/oauth2/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", APP_KEY),
        ])
        .send()
        .await
        .map_err(|e| format!("failed to refresh the Dropbox access token: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox token refresh failed ({status}): {body}"));
    }

    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse the Dropbox token refresh response: {e}"))?;

    // Only some OAuth providers rotate refresh tokens on use — persist the new
    // one only if Dropbox actually sent a different one back.
    if let Some(new_refresh_token) = &token.refresh_token {
        if new_refresh_token != &refresh_token {
            entry
                .set_password(new_refresh_token)
                .map_err(|e| format!("failed to update the Dropbox refresh token in the OS keychain: {e}"))?;
        }
    }

    let expires_at = Instant::now() + Duration::from_secs(token.expires_in.max(0) as u64);
    {
        let mut cache = dropbox.0.lock();
        cache.access_token = Some(token.access_token.clone());
        cache.expires_at = Some(expires_at);
    }

    Ok(token.access_token)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn dropbox_connect(
    db: State<'_, crate::db::DbState>,
    dropbox: State<'_, DropboxState>,
) -> Result<DropboxAccountInfo, String> {
    let (code_verifier, code_challenge) = generate_pkce_pair();

    let authorize_url = format!(
        "https://www.dropbox.com/oauth2/authorize?client_id={}&response_type=code&code_challenge={}&code_challenge_method=S256&redirect_uri={}&token_access_type=offline",
        APP_KEY,
        code_challenge,
        percent_encode(REDIRECT_URI),
    );

    // Bind the one-shot loopback listener *before* opening the browser so the
    // callback can never race ahead of us being ready to receive it.
    let listener = std::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).map_err(|e| {
        format!(
            "failed to start the local Dropbox OAuth callback listener on 127.0.0.1:{CALLBACK_PORT}: {e}"
        )
    })?;

    tauri_plugin_opener::open_url(&authorize_url, None::<&str>)
        .map_err(|e| format!("failed to open the system browser for Dropbox authorization: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_oauth_callback(listener, OAUTH_CALLBACK_TIMEOUT)
    })
    .await
    .map_err(|e| format!("Dropbox OAuth callback task failed: {e}"))??;

    // Exchange the authorization code for tokens (no App Secret — PKCE public
    // client).
    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://api.dropboxapi.com/oauth2/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", APP_KEY),
            ("code_verifier", code_verifier.as_str()),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| format!("failed to exchange the Dropbox authorization code: {e}"))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status();
        let body = token_resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox token exchange failed ({status}): {body}"));
    }

    let token: TokenResponse = token_resp
        .json()
        .await
        .map_err(|e| format!("failed to parse the Dropbox token exchange response: {e}"))?;

    let refresh_token = token.refresh_token.clone().ok_or_else(|| {
        "Dropbox did not return a refresh_token (expected with token_access_type=offline)".to_string()
    })?;

    // Fetch the account's email + display name.
    let account_resp = client
        .post("https://api.dropboxapi.com/2/users/get_current_account")
        .bearer_auth(&token.access_token)
        .header("Content-Type", "application/json")
        .body("null")
        .send()
        .await
        .map_err(|e| format!("failed to fetch the Dropbox account info: {e}"))?;

    if !account_resp.status().is_success() {
        let status = account_resp.status();
        let body = account_resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox get_current_account failed ({status}): {body}"));
    }

    let account: CurrentAccountResponse = account_resp
        .json()
        .await
        .map_err(|e| format!("failed to parse the Dropbox account info response: {e}"))?;

    // Persist the refresh token in the OS keychain — never in SQLite.
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("failed to access the OS keychain: {e}"))?;
    entry
        .set_password(&refresh_token)
        .map_err(|e| format!("failed to save the Dropbox refresh token to the OS keychain: {e}"))?;

    // Cache the access token + expiry in memory so the very next call doesn't
    // need to refresh.
    {
        let mut cache = dropbox.0.lock();
        cache.access_token = Some(token.access_token.clone());
        cache.expires_at = Some(Instant::now() + Duration::from_secs(token.expires_in.max(0) as u64));
    }

    let account_info = DropboxAccountInfo {
        account_id: account.account_id,
        email: account.email,
        display_name: account.name.display_name,
    };

    {
        let conn = db.0.lock();
        crate::db::save_dropbox_connection(&conn, &account_info)?;
    }

    Ok(account_info)
}

#[tauri::command]
pub fn dropbox_get_connection(
    db: State<crate::db::DbState>,
) -> Result<Option<DropboxAccountInfo>, String> {
    let conn = db.0.lock();
    crate::db::get_dropbox_connection(&conn)
}

#[tauri::command]
pub fn dropbox_disconnect(
    db: State<crate::db::DbState>,
    dropbox: State<DropboxState>,
) -> Result<(), String> {
    {
        let mut cache = dropbox.0.lock();
        cache.access_token = None;
        cache.expires_at = None;
    }

    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("failed to remove the Dropbox credentials from the OS keychain: {e}")),
        },
        Err(e) => return Err(format!("failed to access the OS keychain: {e}")),
    }

    let conn = db.0.lock();
    crate::db::clear_dropbox_connection(&conn)
}

#[tauri::command]
pub async fn dropbox_list_app_folder(
    dropbox: State<'_, DropboxState>,
) -> Result<Vec<DropboxFileEntry>, String> {
    let access_token = ensure_fresh_token(&dropbox).await?;
    let client = reqwest::Client::new();

    // App-folder scope means "" is already the app's own root — never the
    // user's real Dropbox root.
    let first_page: ListFolderResult = {
        let resp = client
            .post("https://api.dropboxapi.com/2/files/list_folder")
            .bearer_auth(&access_token)
            .json(&serde_json::json!({ "path": "", "recursive": true }))
            .send()
            .await
            .map_err(|e| format!("failed to list the Dropbox app folder: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Dropbox list_folder failed ({status}): {body}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("failed to parse the Dropbox list_folder response: {e}"))?
    };

    let mut all_entries = first_page.entries;
    let mut cursor = first_page.cursor;
    let mut has_more = first_page.has_more;

    while has_more {
        let resp = client
            .post("https://api.dropboxapi.com/2/files/list_folder/continue")
            .bearer_auth(&access_token)
            .json(&serde_json::json!({ "cursor": cursor }))
            .send()
            .await
            .map_err(|e| format!("failed to continue listing the Dropbox app folder: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Dropbox list_folder/continue failed ({status}): {body}"));
        }

        let page: ListFolderResult = resp
            .json()
            .await
            .map_err(|e| format!("failed to parse the Dropbox list_folder/continue response: {e}"))?;

        cursor = page.cursor;
        has_more = page.has_more;
        all_entries.extend(page.entries);
    }

    let files = all_entries
        .into_iter()
        .filter(|entry| entry.tag == "file")
        .filter(|entry| {
            std::path::Path::new(&entry.name)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .map(|entry| DropboxFileEntry {
            name: entry.name,
            // `path_lower` is always present and normalized (unlike
            // `path_display`, which can be omitted); `dropbox_import_file`
            // relies on getting back the same path it was given here.
            path: entry.path_lower.unwrap_or_default(),
            rev: entry.rev.unwrap_or_default(),
            size: entry.size.unwrap_or(0),
        })
        .collect();

    Ok(files)
}

/// Downloads the given app-folder file into a local cache directory and
/// imports it as a new Track + "dropbox"-sourced Version under `project_id`,
/// following the same pattern as `db::import_local_files` (title from
/// filename, duration via `waveform::probe_duration_seconds` against the
/// *downloaded local cache path*, not the Dropbox path).
#[tauri::command]
pub async fn dropbox_import_file(
    db: State<'_, crate::db::DbState>,
    dropbox: State<'_, DropboxState>,
    app_handle: tauri::AppHandle,
    project_id: String,
    dropbox_path: String,
    dropbox_rev: String,
    file_name: String,
) -> Result<crate::models::Track, String> {
    let access_token = ensure_fresh_token(&dropbox).await?;

    // Content API host — distinct from api.dropboxapi.com, used only for
    // actual file upload/download traffic.
    let api_arg = serde_json::json!({ "path": dropbox_path }).to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post("https://content.dropboxapi.com/2/files/download")
        .bearer_auth(&access_token)
        .header("Dropbox-API-Arg", api_arg)
        .send()
        .await
        .map_err(|e| format!("failed to download '{file_name}' from Dropbox: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox download of '{file_name}' failed ({status}): {body}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("failed to read the downloaded bytes for '{file_name}': {e}"))?;

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    let cache_dir = app_data_dir.join("dropbox_cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("failed to create the Dropbox cache directory: {e}"))?;

    let cache_path = cache_dir.join(format!("{dropbox_rev}_{file_name}"));
    std::fs::write(&cache_path, &bytes)
        .map_err(|e| format!("failed to write the cached file '{}': {e}", cache_path.display()))?;

    let cache_path_str = cache_path.to_string_lossy().into_owned();
    let duration_seconds =
        crate::waveform::probe_duration_seconds(cache_path_str.clone()).unwrap_or(0.0);

    let conn = db.0.lock();
    crate::db::insert_dropbox_track(
        &conn,
        &project_id,
        &file_name,
        &cache_path_str,
        &dropbox_path,
        &dropbox_rev,
        duration_seconds,
    )
}

/// Hands the stored refresh token to the frontend for exactly one purpose:
/// registering it with our Cloud Functions (`storeDropboxToken`) so the
/// server can mint temporary streaming links for guest share pages. This is
/// the one deliberate, documented exception to "tokens never leave the
/// keychain" (see the share-link section of the project plan) — do not call
/// it anywhere else.
#[tauri::command]
pub fn dropbox_get_refresh_token() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(token),
        Err(keyring::Error::NoEntry) => Err("Dropbox is not connected".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Dropbox's single-request upload limit; larger files need upload sessions,
/// which aren't implemented yet (surfaced as a clear error instead).
const UPLOAD_SINGLE_SHOT_LIMIT: u64 = 150 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct UploadResult {
    path_lower: Option<String>,
    path_display: Option<String>,
    rev: String,
}

/// Uploads a version's local file into the Dropbox app folder (needed before
/// it can be shared with a guest link) and records the resulting app-folder
/// path + rev on the version. No-op if the version is already in Dropbox.
#[tauri::command]
pub async fn dropbox_upload_version(
    db: State<'_, crate::db::DbState>,
    dropbox: State<'_, DropboxState>,
    version_id: String,
) -> Result<crate::models::Version, String> {
    // Read what we need, then release the DB lock before any await — the
    // rusqlite connection guard must not be held across suspension points.
    let version = {
        let conn = db.0.lock();
        crate::db::get_version(&conn, &version_id)?
    };

    if version.dropbox_path.is_some() {
        return Ok(version);
    }

    let local_path = version.file.path.clone();
    let file_name = std::path::Path::new(&local_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("this version has no usable file name")?;

    let metadata = std::fs::metadata(&local_path)
        .map_err(|e| format!("could not read '{file_name}': {e}"))?;
    if metadata.len() > UPLOAD_SINGLE_SHOT_LIMIT {
        return Err(format!(
            "'{file_name}' is larger than 150 MB — uploads that size aren't supported yet"
        ));
    }
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("could not read '{file_name}': {e}"))?;

    let access_token = ensure_fresh_token(&dropbox).await?;

    // Keyed by version id so different versions of the same-named file never
    // collide in the app folder.
    let target_path = format!("/shared/{version_id}/{file_name}");
    let api_arg = serde_json::json!({
        "path": target_path,
        "mode": "overwrite",
        "autorename": false,
        "mute": true
    })
    .to_string();

    let client = reqwest::Client::new();
    let resp = client
        .post("https://content.dropboxapi.com/2/files/upload")
        .bearer_auth(&access_token)
        .header("Dropbox-API-Arg", api_arg)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("failed to upload '{file_name}' to Dropbox: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox upload of '{file_name}' failed ({status}): {body}"));
    }

    let uploaded: UploadResult = resp
        .json()
        .await
        .map_err(|e| format!("unexpected Dropbox upload response: {e}"))?;
    let stored_path = uploaded
        .path_lower
        .or(uploaded.path_display)
        .unwrap_or(target_path);

    let conn = db.0.lock();
    crate::db::set_version_dropbox_location(&conn, &version_id, &stored_path, &uploaded.rev)?;
    crate::db::get_version(&conn, &version_id)
}
