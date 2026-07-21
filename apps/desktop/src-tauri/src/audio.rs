use std::fs::File;
use std::io::BufReader;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use tauri::{Emitter, Manager};

/// `cpal::Stream` (used internally by `rodio::OutputStream`) is not proven
/// `Send` on every backend — e.g. macOS's CoreAudio backend holds a raw
/// `AudioUnit` handle and a boxed device-disconnect callback that the crate
/// doesn't mark `Send`. We never read or mutate the stream after creating it
/// (it just has to stay alive to keep the device open), and every access to
/// `AudioPlayer` is already serialized through `AudioState`'s `Mutex`, so
/// asserting `Send` here is safe in practice even though it isn't derived.
struct AudioOutputStream(#[allow(dead_code)] OutputStream);
unsafe impl Send for AudioOutputStream {}

/// Holds the native audio playback engine. `_stream` must stay alive for the
/// duration of playback (dropping it silences audio), hence it's kept here
/// even though it's never read directly.
///
/// Position tracking does not poll rodio internals: instead we remember the
/// accumulated position (`position_seconds`, updated on pause/seek/load) plus
/// the `Instant` playback most recently resumed at (`started_at`). Current
/// position while playing is simply `position_seconds + started_at.elapsed()`.
pub struct AudioPlayer {
    _stream: Option<AudioOutputStream>,
    stream_handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,

    path: Option<String>,
    duration_seconds: f64,
    position_seconds: f64,
    is_playing: bool,
    started_at: Option<Instant>,
    volume: f32,
}

impl AudioPlayer {
    fn new() -> Self {
        let (stream, stream_handle) = match OutputStream::try_default() {
            Ok((stream, handle)) => (Some(AudioOutputStream(stream)), Some(handle)),
            Err(err) => {
                eprintln!("audio: failed to open default output device: {err}");
                (None, None)
            }
        };

        AudioPlayer {
            _stream: stream,
            stream_handle,
            sink: None,
            path: None,
            duration_seconds: 0.0,
            position_seconds: 0.0,
            is_playing: false,
            started_at: None,
            volume: 1.0,
        }
    }

    /// Current playback position in seconds, computed from bookkeeping state
    /// rather than by polling the sink/decoder.
    fn current_position(&self) -> f64 {
        let elapsed = if self.is_playing {
            self.started_at
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0)
        } else {
            0.0
        };
        let position = self.position_seconds + elapsed;
        if self.duration_seconds > 0.0 {
            position.min(self.duration_seconds)
        } else {
            position
        }
    }

    fn status(&self) -> PlaybackStatus {
        PlaybackStatus {
            position_seconds: self.current_position(),
            duration_seconds: self.duration_seconds,
            is_playing: self.is_playing,
        }
    }
}

impl Default for AudioPlayer {
    fn default() -> Self {
        AudioPlayer::new()
    }
}

pub struct AudioState(pub Mutex<AudioPlayer>);

#[tauri::command]
pub fn audio_load(state: tauri::State<AudioState>, path: String) -> Result<(), String> {
    let mut player = state.0.lock();

    let stream_handle = player
        .stream_handle
        .as_ref()
        .ok_or_else(|| "no audio output device available".to_string())?
        .clone();
    let volume = player.volume;

    let file = File::open(&path).map_err(|e| format!("failed to open {path}: {e}"))?;
    let source = Decoder::new(BufReader::new(file))
        .map_err(|e| format!("failed to decode {path}: {e}"))?;
    let duration = crate::waveform::probe_duration_seconds(path.clone())?;

    let sink = Sink::try_new(&stream_handle)
        .map_err(|e| format!("failed to create audio sink: {e}"))?;
    sink.set_volume(volume);
    sink.append(source);
    // audio_load must not auto-play.
    sink.pause();

    // Only replace player state once the new sink is fully ready, so a failed
    // load leaves the previously loaded track (if any) untouched.
    player.sink = Some(sink);
    player.path = Some(path);
    player.duration_seconds = duration;
    player.position_seconds = 0.0;
    player.is_playing = false;
    player.started_at = None;

    Ok(())
}

#[tauri::command]
pub fn audio_play(state: tauri::State<AudioState>) -> Result<(), String> {
    let mut player = state.0.lock();
    let sink = player
        .sink
        .as_ref()
        .ok_or_else(|| "no track loaded".to_string())?;
    sink.play();
    player.is_playing = true;
    player.started_at = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub fn audio_pause(state: tauri::State<AudioState>) -> Result<(), String> {
    let mut player = state.0.lock();
    if let Some(sink) = player.sink.as_ref() {
        sink.pause();
    }
    if let Some(started_at) = player.started_at.take() {
        player.position_seconds += started_at.elapsed().as_secs_f64();
    }
    player.is_playing = false;
    Ok(())
}

#[tauri::command]
pub fn audio_seek(state: tauri::State<AudioState>, position_seconds: f64) -> Result<(), String> {
    let mut player = state.0.lock();

    let path = player
        .path
        .clone()
        .ok_or_else(|| "no track loaded".to_string())?;
    let duration = player.duration_seconds;
    let volume = player.volume;
    let was_playing = player.is_playing;

    let target = if duration > 0.0 {
        position_seconds.clamp(0.0, duration)
    } else {
        position_seconds.max(0.0)
    };

    // Prefer an in-place seek on the currently loaded sink/decoder. With the
    // symphonia-all backend this succeeds for mp3/wav/flac/aac/m4a.
    let seek_ok = match player.sink.as_ref() {
        Some(sink) => sink.try_seek(Duration::from_secs_f64(target)).is_ok(),
        None => false,
    };

    if !seek_ok {
        // Fallback for sources that don't support try_seek cleanly: reload the
        // file from scratch and eagerly skip decoded samples up to the target
        // position via `Source::skip_duration`.
        let stream_handle = player
            .stream_handle
            .as_ref()
            .ok_or_else(|| "no audio output device available".to_string())?
            .clone();

        let file = File::open(&path).map_err(|e| format!("failed to open {path}: {e}"))?;
        let source = Decoder::new(BufReader::new(file))
            .map_err(|e| format!("failed to decode {path}: {e}"))?
            .skip_duration(Duration::from_secs_f64(target));

        let sink = Sink::try_new(&stream_handle)
            .map_err(|e| format!("failed to create audio sink: {e}"))?;
        sink.set_volume(volume);
        sink.append(source);
        if !was_playing {
            sink.pause();
        }
        player.sink = Some(sink);
    }

    player.position_seconds = target;
    player.started_at = if was_playing {
        Some(Instant::now())
    } else {
        None
    };

    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(state: tauri::State<AudioState>, volume: f32) -> Result<(), String> {
    let mut player = state.0.lock();
    let clamped = volume.clamp(0.0, 1.0);
    player.volume = clamped;
    if let Some(sink) = player.sink.as_ref() {
        sink.set_volume(clamped);
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub is_playing: bool,
}

#[tauri::command]
pub fn audio_get_status(state: tauri::State<AudioState>) -> Result<PlaybackStatus, String> {
    let player = state.0.lock();
    Ok(player.status())
}

/// Starts a background thread that emits a `playback://status` event (payload:
/// `PlaybackStatus`) to the frontend a few times a second while a track is loaded,
/// so the UI can drive the scrubber without polling. Called once from `lib.rs` setup.
pub fn start_status_emitter(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));

        let status = {
            let state = app_handle.state::<AudioState>();
            let player = state.0.lock();
            // Only emit while a track is actually loaded; it's fine to keep
            // emitting while paused so the UI stays in sync.
            if player.duration_seconds > 0.0 {
                Some(player.status())
            } else {
                None
            }
        };

        if let Some(status) = status {
            let _ = app_handle.emit("playback://status", status);
        }
    });
}
