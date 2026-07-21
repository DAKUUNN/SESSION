use parking_lot::Mutex;

/// Holds the native audio playback engine. `_stream` must stay alive for the
/// duration of playback (dropping it silences audio), hence it's kept here
/// even though it's never read directly.
pub struct AudioPlayer {
    // implementing agent: rodio OutputStream/Sink (or equivalent) + position bookkeeping live here
}

impl Default for AudioPlayer {
    fn default() -> Self {
        AudioPlayer {}
    }
}

pub struct AudioState(pub Mutex<AudioPlayer>);

#[tauri::command]
pub fn audio_load(state: tauri::State<AudioState>, path: String) -> Result<(), String> {
    let _ = (state, path);
    Ok(())
}

#[tauri::command]
pub fn audio_play(state: tauri::State<AudioState>) -> Result<(), String> {
    let _ = state;
    Ok(())
}

#[tauri::command]
pub fn audio_pause(state: tauri::State<AudioState>) -> Result<(), String> {
    let _ = state;
    Ok(())
}

#[tauri::command]
pub fn audio_seek(state: tauri::State<AudioState>, position_seconds: f64) -> Result<(), String> {
    let _ = (state, position_seconds);
    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(state: tauri::State<AudioState>, volume: f32) -> Result<(), String> {
    let _ = (state, volume);
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
    let _ = state;
    Ok(PlaybackStatus {
        position_seconds: 0.0,
        duration_seconds: 0.0,
        is_playing: false,
    })
}

/// Starts a background thread that emits a `playback://status` event (payload:
/// `PlaybackStatus`) to the frontend a few times a second while a track is loaded,
/// so the UI can drive the scrubber without polling. Called once from `lib.rs` setup.
pub fn start_status_emitter(app_handle: tauri::AppHandle) {
    let _ = app_handle;
}
