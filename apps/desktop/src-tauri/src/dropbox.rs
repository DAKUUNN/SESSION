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
//! 5. Exchange the code for tokens: `POST https://api.dropbox.com/oauth2/token`
//!    with form fields `grant_type=authorization_code`, `code=<code>`,
//!    `client_id=0p4wy3rkh5d9yi6`, `code_verifier=<verifier>`,
//!    `redirect_uri=http://localhost:5173/dropbox/callback` (still no secret).
//!    Response JSON includes `access_token`, `expires_in` (seconds),
//!    `refresh_token`, `account_id`.
//! 6. Call `POST https://api.dropbox.com/2/users/get_current_account` with
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
use parking_lot::Mutex;
use tauri::State;

const APP_KEY: &str = "0p4wy3rkh5d9yi6";
const REDIRECT_URI: &str = "http://localhost:5173/dropbox/callback";
const KEYCHAIN_SERVICE: &str = "com.peaksense.session";
const KEYCHAIN_ACCOUNT: &str = "dropbox";

/// In-memory access-token cache, populated on connect and refreshed on
/// demand. The refresh_token itself lives only in the OS keychain.
#[derive(Default)]
pub struct DropboxTokenCache {
    // implementing agent: access_token: Option<String>, expires_at: Option<Instant>
}

pub struct DropboxState(pub Mutex<DropboxTokenCache>);

#[tauri::command]
pub async fn dropbox_connect(
    db: State<'_, crate::db::DbState>,
    dropbox: State<'_, DropboxState>,
) -> Result<DropboxAccountInfo, String> {
    let _ = (db, dropbox);
    Err("not implemented".into())
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
    let _ = dropbox;
    let conn = db.0.lock();
    crate::db::clear_dropbox_connection(&conn)
    // implementing agent: also remove the keyring entry
}

#[tauri::command]
pub async fn dropbox_list_app_folder(
    dropbox: State<'_, DropboxState>,
) -> Result<Vec<DropboxFileEntry>, String> {
    let _ = dropbox;
    Ok(vec![])
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
    let _ = (db, dropbox, app_handle, project_id, dropbox_path, dropbox_rev, file_name);
    Err("not implemented".into())
}
