//! Cover-art color sampling for the "adaptive accent" appearance setting.
//!
//! Deliberately done here in Rust rather than via an HTML `<canvas>` in the
//! frontend: cover images are loaded into the webview through Tauri's asset
//! protocol, and reading pixel data back out of a `<canvas>` for an image
//! loaded that way commonly hits a tainted-canvas `SecurityError` (the asset
//! protocol response isn't guaranteed to carry the CORS headers a canvas
//! read requires) — which is silent from the frontend's point of view: the
//! toggle would visibly do nothing. Decoding the file directly on disk
//! sidesteps that entirely.

#[tauri::command]
pub fn sample_cover_color(path: String) -> Result<(u8, u8, u8), String> {
    let img = image::open(&path).map_err(|e| format!("couldn't read '{path}': {e}"))?;
    let small = img
        .resize(24, 24, image::imageops::FilterType::Nearest)
        .to_rgba8();

    let mut r: u64 = 0;
    let mut g: u64 = 0;
    let mut b: u64 = 0;
    let mut count: u64 = 0;
    for pixel in small.pixels() {
        if pixel[3] < 200 {
            continue; // skip near-transparent edge pixels
        }
        r += pixel[0] as u64;
        g += pixel[1] as u64;
        b += pixel[2] as u64;
        count += 1;
    }

    if count == 0 {
        return Err("cover art has no opaque pixels to sample".into());
    }
    Ok(((r / count) as u8, (g / count) as u8, (b / count) as u8))
}
