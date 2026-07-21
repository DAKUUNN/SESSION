use crate::models::{FileRef, Favorite, Playlist, PlaylistItem, Project, ProjectDetail, Track, Version};
use crate::waveform;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use tauri::State;

pub struct DbState(pub Mutex<Connection>);

/// Opens the SQLite database in the app's data directory and creates the schema
/// if it doesn't exist yet. Called once at startup from `lib.rs`.
pub fn init(app_data_dir: &std::path::Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("session.sqlite3");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            cover_source TEXT,
            cover_path TEXT,
            cover_rev TEXT,
            cover_fingerprint TEXT,
            cover_style TEXT NOT NULL DEFAULT 'individual',
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            default_version_id TEXT,
            cover_source TEXT,
            cover_path TEXT,
            cover_rev TEXT,
            cover_fingerprint TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS versions (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            file_source TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_rev TEXT,
            file_fingerprint TEXT,
            duration_seconds REAL NOT NULL,
            bpm REAL,
            key TEXT,
            peak_data_path TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS playlist_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL,
            version_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS favorites (
            track_id TEXT NOT NULL,
            version_id TEXT,
            favorited_at TEXT NOT NULL,
            PRIMARY KEY (track_id, version_id)
        );
        ",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

// ---------- Projects ----------

#[tauri::command]
pub fn list_projects(state: State<DbState>) -> Result<Vec<Project>, String> {
    let _ = state;
    Ok(vec![])
}

#[tauri::command]
pub fn create_project(state: State<DbState>, name: String, kind: String) -> Result<Project, String> {
    let _ = (state, name, kind);
    Err("not implemented".into())
}

#[tauri::command]
pub fn set_project_cover_style(state: State<DbState>, project_id: String, style: String) -> Result<(), String> {
    let _ = (state, project_id, style);
    Ok(())
}

#[tauri::command]
pub fn get_project_detail(state: State<DbState>, project_id: String) -> Result<ProjectDetail, String> {
    let _ = (state, project_id);
    Err("not implemented".into())
}

// ---------- Tracks & versions ----------

/// Imports local audio files as new tracks (one track + one "Original" version per file)
/// under the given project. Uses `waveform::probe_duration_seconds` to fill in duration.
#[tauri::command]
pub fn import_local_files(
    state: State<DbState>,
    project_id: String,
    file_paths: Vec<String>,
) -> Result<Vec<Track>, String> {
    let _ = (state, project_id, file_paths, waveform::probe_duration_seconds("".into()));
    Ok(vec![])
}

#[tauri::command]
pub fn list_versions(state: State<DbState>, track_id: String) -> Result<Vec<Version>, String> {
    let _ = (state, track_id);
    Ok(vec![])
}

#[tauri::command]
pub fn set_default_version(state: State<DbState>, track_id: String, version_id: String) -> Result<(), String> {
    let _ = (state, track_id, version_id);
    Ok(())
}

// ---------- Playlists & favorites ----------

#[tauri::command]
pub fn list_playlists(state: State<DbState>) -> Result<Vec<Playlist>, String> {
    let _ = state;
    Ok(vec![])
}

#[tauri::command]
pub fn create_playlist(state: State<DbState>, name: String) -> Result<Playlist, String> {
    let _ = (state, name);
    Err("not implemented".into())
}

#[tauri::command]
pub fn add_to_playlist(
    state: State<DbState>,
    playlist_id: String,
    track_id: String,
    version_id: Option<String>,
) -> Result<(), String> {
    let _ = (state, playlist_id, track_id, version_id);
    Ok(())
}

#[tauri::command]
pub fn list_favorites(state: State<DbState>) -> Result<Vec<Favorite>, String> {
    let _ = state;
    Ok(vec![])
}

#[tauri::command]
pub fn toggle_favorite(
    state: State<DbState>,
    track_id: String,
    version_id: Option<String>,
) -> Result<bool, String> {
    let _ = (state, track_id, version_id);
    Ok(false)
}

// silence "unused" warnings for stub-only imports until real implementation lands
#[allow(dead_code)]
fn _unused(_: FileRef, _: HashMap<String, Vec<Version>>, _: PlaylistItem) {}
