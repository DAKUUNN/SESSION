//! Licensing via Lemon Squeezy's public License API, plus the loopback
//! listener for Firebase's email-link ("magic link") sign-in.
//!
//! ## Why no server / no webhook / no App Secret
//! Lemon Squeezy's `/v1/licenses/activate|validate|deactivate` endpoints are
//! deliberately public (no API key required) so desktop apps can call them
//! directly. Purchase happens on the Lemon Squeezy checkout page (desktop/web
//! only, never inside the iOS app); the customer receives a license key by
//! email, enters it once here, and the app activates it as one "instance".
//! The frontend then mirrors the key into the signed-in user's Firestore doc,
//! which is what lets the iOS build unlock via account sign-in instead of
//! Apple in-app purchase.
//!
//! The activation response's `meta.product_id` is checked against Session's
//! product (1204629) so a key bought for some other Lemon Squeezy product
//! doesn't unlock this app.
//!
//! ## Storage
//! The activated license (key + instance id + status) is stored as JSON in
//! the OS keychain — service "com.peaksense.session", account
//! "lemonsqueezy-license". Never in SQLite, same policy as Dropbox tokens.
//!
//! ## Auth loopback (port 5174)
//! Firebase email-link sign-in embeds a continue URL in the emailed link.
//! We use `http://localhost:5174/auth/callback` — port 5174 because 1420 is
//! Vite's dev server and 5173 is the Dropbox OAuth listener (see dropbox.rs).
//! `auth_wait_for_email_link_callback` binds that port, waits for the user to
//! click the link in their email (which opens the system browser and lands on
//! the loopback), and returns the full callback URL. The frontend then passes
//! that URL to Firebase's `signInWithEmailLink`.

use crate::models::LicenseInfo;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const LS_LICENSE_API: &str = "https://api.lemonsqueezy.com/v1/licenses";
/// Session's product id in the Peak-Sense Lemon Squeezy store.
const SESSION_PRODUCT_ID: u64 = 1204629;
const KEYCHAIN_SERVICE: &str = "com.peaksense.session";
const KEYCHAIN_ACCOUNT: &str = "lemonsqueezy-license";
const AUTH_CALLBACK_PORT: u16 = 5174;
/// Email round-trips are slower than OAuth consent screens — give the user
/// five minutes to open their inbox and click the link.
const AUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

// ---------- Lemon Squeezy response shapes ----------

#[derive(serde::Deserialize)]
struct LsResponse {
    #[serde(default)]
    activated: bool,
    #[serde(default)]
    valid: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    license_key: Option<LsLicenseKey>,
    #[serde(default)]
    instance: Option<LsInstance>,
    #[serde(default)]
    meta: Option<LsMeta>,
}

#[derive(serde::Deserialize)]
struct LsLicenseKey {
    status: String,
}

#[derive(serde::Deserialize)]
struct LsInstance {
    id: String,
}

#[derive(serde::Deserialize)]
struct LsMeta {
    product_id: u64,
    #[serde(default)]
    product_name: Option<String>,
    #[serde(default)]
    customer_email: Option<String>,
}

async fn ls_post(endpoint: &str, form: &[(&str, &str)]) -> Result<LsResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{LS_LICENSE_API}/{endpoint}"))
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("could not reach Lemon Squeezy: {e}"))?;
    resp.json::<LsResponse>()
        .await
        .map_err(|e| format!("unexpected response from Lemon Squeezy: {e}"))
}

// ---------- Keychain storage ----------

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn load_stored_license() -> Result<Option<LicenseInfo>, String> {
    match keychain_entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("stored license is corrupted: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save_stored_license(info: &LicenseInfo) -> Result<(), String> {
    let json = serde_json::to_string(info).map_err(|e| e.to_string())?;
    keychain_entry()?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

fn delete_stored_license() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- Commands ----------

/// Activates a license key as a new instance on this device, verifies it
/// belongs to Session's product, and stores it in the OS keychain.
#[tauri::command]
pub async fn license_activate(license_key: String) -> Result<LicenseInfo, String> {
    let key = license_key.trim().to_string();
    if key.is_empty() {
        return Err("please enter a license key".into());
    }

    let instance_name = format!("Session ({})", std::env::consts::OS);
    let body = ls_post(
        "activate",
        &[("license_key", key.as_str()), ("instance_name", instance_name.as_str())],
    )
    .await?;

    if !body.activated {
        return Err(body
            .error
            .unwrap_or_else(|| "license activation failed".into()));
    }

    let meta = body.meta.ok_or("Lemon Squeezy returned no product info")?;
    if meta.product_id != SESSION_PRODUCT_ID {
        return Err("this license key belongs to a different product".into());
    }

    let info = LicenseInfo {
        key,
        instance_id: body.instance.map(|i| i.id).unwrap_or_default(),
        status: body
            .license_key
            .map(|l| l.status)
            .unwrap_or_else(|| "active".into()),
        product_name: meta.product_name,
        customer_email: meta.customer_email,
        activated_at: chrono::Utc::now().to_rfc3339(),
    };
    save_stored_license(&info)?;
    Ok(info)
}

/// Returns the locally stored license without a network round-trip (so the
/// app unlocks instantly offline). Use `license_validate` for a fresh check.
#[tauri::command]
pub fn license_get() -> Result<Option<LicenseInfo>, String> {
    load_stored_license()
}

/// Re-validates the stored license against Lemon Squeezy and updates the
/// stored status. Errors if no license is stored or the key is no longer valid.
#[tauri::command]
pub async fn license_validate() -> Result<LicenseInfo, String> {
    let mut stored = load_stored_license()?.ok_or("no license stored on this device")?;

    let body = ls_post(
        "validate",
        &[
            ("license_key", stored.key.as_str()),
            ("instance_id", stored.instance_id.as_str()),
        ],
    )
    .await?;

    if let Some(license_key) = body.license_key {
        stored.status = license_key.status;
    }
    save_stored_license(&stored)?;

    if !body.valid {
        return Err(body
            .error
            .unwrap_or_else(|| format!("license is no longer valid (status: {})", stored.status)));
    }
    Ok(stored)
}

/// Deactivates this device's instance (freeing an activation slot) and
/// removes the license from the keychain.
#[tauri::command]
pub async fn license_deactivate() -> Result<(), String> {
    if let Some(stored) = load_stored_license()? {
        // Best effort: even if the network call fails, still remove locally so
        // the user isn't stuck with an un-removable license.
        let _ = ls_post(
            "deactivate",
            &[
                ("license_key", stored.key.as_str()),
                ("instance_id", stored.instance_id.as_str()),
            ],
        )
        .await;
    }
    delete_stored_license()
}

/// Binds the auth loopback port and waits (up to 5 minutes) for the user to
/// click the Firebase email link, then returns the full callback URL for the
/// frontend to pass into `signInWithEmailLink`.
#[tauri::command]
pub async fn auth_wait_for_email_link_callback() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let listener = std::net::TcpListener::bind(("127.0.0.1", AUTH_CALLBACK_PORT))
            .map_err(|e| format!("could not listen for the sign-in link (port {AUTH_CALLBACK_PORT}): {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;

        let deadline = Instant::now() + AUTH_CALLBACK_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).ok();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .ok();

                    let mut buf = [0u8; 16384];
                    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();

                    let html = "<html><body style=\"font-family:sans-serif;background:#0c1016;color:#e7edf2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Signed in \u{2014} you can close this tab and return to Session.</p></body></html>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        html.len(),
                        html
                    );
                    stream.write_all(response.as_bytes()).ok();

                    return Ok(format!("http://localhost:{AUTH_CALLBACK_PORT}{path}"));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(
                            "timed out waiting for you to click the sign-in link".into()
                        );
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => return Err(format!("sign-in listener error: {e}")),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
