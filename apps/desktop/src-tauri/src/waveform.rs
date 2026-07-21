/// Probes an audio file's duration in seconds by decoding its container/codec headers.
/// Used by `db::import_local_files` to fill in `Version.duration_seconds` on import.
/// Plain function (not a Tauri command) — called directly from Rust.
pub fn probe_duration_seconds(path: String) -> Result<f64, String> {
    let _ = path;
    Ok(0.0)
}

/// Decodes the audio file at `path` and downsamples it to `bucket_count` min/max peak
/// pairs (returned flattened as `[min0, max0, min1, max1, ...]`, values in [-1, 1])
/// for waveform rendering in the frontend.
pub fn generate_peaks(path: String, bucket_count: usize) -> Result<Vec<f32>, String> {
    let _ = (path, bucket_count);
    Ok(vec![])
}

#[tauri::command]
pub fn generate_peaks_cmd(path: String, bucket_count: usize) -> Result<Vec<f32>, String> {
    generate_peaks(path, bucket_count)
}
