use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CodecParameters, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Opens the media file at `path`, probes its container format, and returns the format reader
/// along with the id and codec parameters of the default audio track.
fn open_default_track(
    path: &str,
) -> Result<(Box<dyn FormatReader>, u32, CodecParameters), String> {
    let file =
        File::open(path).map_err(|e| format!("failed to open '{}': {}", path, e))?;

    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("failed to probe format for '{}': {}", path, e))?;

    let format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| format!("no audio track found in '{}'", path))?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    Ok((format, track_id, codec_params))
}

/// Returns `true` if the given symphonia error indicates a clean end-of-stream condition.
fn is_end_of_stream(err: &SymphoniaError) -> bool {
    matches!(err, SymphoniaError::IoError(e) if e.kind() == ErrorKind::UnexpectedEof)
}

/// Probes an audio file's duration in seconds by decoding its container/codec headers.
/// Used by `db::import_local_files` to fill in `Version.duration_seconds` on import.
/// Plain function (not a Tauri command) — called directly from Rust.
pub fn probe_duration_seconds(path: String) -> Result<f64, String> {
    let (mut format, track_id, codec_params) = open_default_track(&path)?;

    // Prefer the header-based calculation: it's much faster since it doesn't require decoding
    // the whole file.
    if let (Some(time_base), Some(n_frames)) = (codec_params.time_base, codec_params.n_frames) {
        let time = time_base.calc_time(n_frames);
        return Ok(time.seconds as f64 + time.frac);
    }

    // Fall back to decoding the whole file and accumulating the number of decoded frames. This
    // is slower, but works for formats/files that don't report `n_frames` in their headers.
    let sample_rate = codec_params
        .sample_rate
        .ok_or_else(|| format!("no sample rate available for '{}'", path))?;

    let dec_opts = DecoderOptions::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &dec_opts)
        .map_err(|e| format!("unsupported codec for '{}': {}", path, e))?;

    let mut total_frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(ref e) if is_end_of_stream(e) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("error reading packet from '{}': {}", path, e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                total_frames += decoded.frames() as u64;
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(ref e) if is_end_of_stream(e) => break,
            Err(e) => return Err(format!("error decoding '{}': {}", path, e)),
        }
    }

    Ok(total_frames as f64 / f64::from(sample_rate))
}

/// Decodes the audio file at `path` and downsamples it to `bucket_count` min/max peak
/// pairs (returned flattened as `[min0, max0, min1, max1, ...]`, values in [-1, 1])
/// for waveform rendering in the frontend.
pub fn generate_peaks(path: String, bucket_count: usize) -> Result<Vec<f32>, String> {
    if bucket_count == 0 {
        return Ok(vec![]);
    }

    let (mut format, track_id, codec_params) = open_default_track(&path)?;

    let dec_opts = DecoderOptions::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &dec_opts)
        .map_err(|e| format!("unsupported codec for '{}': {}", path, e))?;

    // Decode every packet, mixing each sample frame down to mono by averaging its channels.
    let mut mono: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut n_channels: usize = 1;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(ref e) if is_end_of_stream(e) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("error reading packet from '{}': {}", path, e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(ref e) if is_end_of_stream(e) => break,
            Err(e) => return Err(format!("error decoding '{}': {}", path, e)),
        };

        if sample_buf.is_none() {
            let spec = *decoded.spec();
            n_channels = spec.channels.count().max(1);
            let duration = decoded.capacity() as u64;
            sample_buf = Some(SampleBuffer::<f32>::new(duration, spec));
        }

        if let Some(buf) = sample_buf.as_mut() {
            buf.copy_interleaved_ref(decoded);

            for frame in buf.samples().chunks_exact(n_channels) {
                let sum: f32 = frame.iter().sum();
                mono.push(sum / n_channels as f32);
            }
        }
    }

    let total_samples = mono.len();
    let mut peaks = vec![0.0f32; bucket_count * 2];

    if total_samples == 0 {
        // No decodable audio data — return all-zero buckets rather than erroring.
        return Ok(peaks);
    }

    let mut touched = vec![false; bucket_count];

    for (i, &sample) in mono.iter().enumerate() {
        // Use 128-bit arithmetic to avoid any overflow for large files/bucket counts.
        let bucket_idx =
            ((i as u128 * bucket_count as u128) / total_samples as u128) as usize;
        let bucket_idx = bucket_idx.min(bucket_count - 1);

        if !touched[bucket_idx] {
            peaks[bucket_idx * 2] = sample;
            peaks[bucket_idx * 2 + 1] = sample;
            touched[bucket_idx] = true;
        }
        else {
            if sample < peaks[bucket_idx * 2] {
                peaks[bucket_idx * 2] = sample;
            }
            if sample > peaks[bucket_idx * 2 + 1] {
                peaks[bucket_idx * 2 + 1] = sample;
            }
        }
    }

    Ok(peaks)
}

#[tauri::command]
pub fn generate_peaks_cmd(path: String, bucket_count: usize) -> Result<Vec<f32>, String> {
    generate_peaks(path, bucket_count)
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use std::io::Write;

    /// Returns a unique path in the OS temp dir for a test fixture file.
    fn temp_wav_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "session_waveform_test_{}_{}.wav",
            std::process::id(),
            name
        ))
    }

    fn write_test_wav(path: &Path, sample_rate: u32, seconds: f64, channels: u16) {
        let n_frames = (sample_rate as f64 * seconds) as u32;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * channels as u32 * (bits_per_sample as u32 / 8);
        let block_align = channels * (bits_per_sample / 8);
        let data_size = n_frames * channels as u32 * (bits_per_sample as u32 / 8);
        let mut f = File::create(path).unwrap();

        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        f.write_all(b"WAVE").unwrap();
        f.write_all(b"fmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&block_align.to_le_bytes()).unwrap();
        f.write_all(&bits_per_sample.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_size.to_le_bytes()).unwrap();

        for i in 0..n_frames {
            let t = i as f64 / sample_rate as f64;
            let v = (t * 440.0 * 2.0 * std::f64::consts::PI).sin();
            let sample = (v * i16::MAX as f64) as i16;
            for _ in 0..channels {
                f.write_all(&sample.to_le_bytes()).unwrap();
            }
        }
    }

    #[test]
    fn test_probe_duration_seconds_wav() {
        let path = temp_wav_path("duration");
        write_test_wav(&path, 8000, 1.0, 1);

        let duration = probe_duration_seconds(path.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!((duration - 1.0).abs() < 0.01, "duration was {}", duration);
    }

    #[test]
    fn test_generate_peaks_wav() {
        let path = temp_wav_path("stereo_peaks");
        write_test_wav(&path, 8000, 1.0, 2);

        let peaks = generate_peaks(path.to_string_lossy().into_owned(), 100).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(peaks.len(), 200);

        for chunk in peaks.chunks_exact(2) {
            assert!(chunk[0] >= -1.0 && chunk[0] <= 1.0);
            assert!(chunk[1] >= -1.0 && chunk[1] <= 1.0);
            assert!(chunk[0] <= chunk[1]);
        }

        // Some buckets should have actually seen non-trivial signal (not all zero).
        let any_nonzero = peaks.iter().any(|&v| v.abs() > 0.01);
        assert!(any_nonzero, "expected some non-zero peaks, got {:?}", peaks);
    }

    #[test]
    fn test_generate_peaks_more_buckets_than_samples() {
        let path = temp_wav_path("short_peaks");
        write_test_wav(&path, 8000, 0.001, 1); // ~8 frames

        let peaks = generate_peaks(path.to_string_lossy().into_owned(), 100).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(peaks.len(), 200);
        // Should not error, and most buckets should be zero-padded.
        let zero_buckets = peaks.chunks_exact(2).filter(|c| c[0] == 0.0 && c[1] == 0.0).count();
        assert!(zero_buckets > 50, "expected many zero-padded buckets, got {}", zero_buckets);
    }

    #[test]
    fn test_generate_peaks_zero_buckets() {
        let path = temp_wav_path("zero_buckets");
        write_test_wav(&path, 8000, 1.0, 1);

        let peaks = generate_peaks(path.to_string_lossy().into_owned(), 0).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(peaks.len(), 0);
    }
}
