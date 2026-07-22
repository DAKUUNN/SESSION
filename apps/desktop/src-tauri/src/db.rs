use crate::models::{
    FileRef, Favorite, Playlist, PlaylistItem, PlaylistTrackEntry, Project, ProjectDetail, Track,
    Version,
};
use crate::waveform;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

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
        CREATE TABLE IF NOT EXISTS dropbox_connection (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            account_id TEXT NOT NULL,
            email TEXT NOT NULL,
            display_name TEXT NOT NULL,
            connected_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            download_dir TEXT
        );
        ",
    )
    .map_err(|e| e.to_string())?;

    // Additive migration for pre-existing databases: versions gained a
    // `dropbox_path` column (the app-folder path once a version has been
    // uploaded/synced to Dropbox, needed for share links). SQLite has no
    // ADD COLUMN IF NOT EXISTS, so tolerate the duplicate-column error.
    if let Err(e) = conn.execute("ALTER TABLE versions ADD COLUMN dropbox_path TEXT", []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column") {
            return Err(msg);
        }
    }

    Ok(conn)
}

// ---------- Row mapping helpers ----------

fn file_ref_from_parts(
    source: Option<String>,
    path: Option<String>,
    rev: Option<String>,
    fingerprint: Option<String>,
) -> Option<FileRef> {
    source.map(|source| FileRef {
        source,
        path: path.unwrap_or_default(),
        rev,
        fingerprint,
    })
}

/// Expects columns in order: id, name, kind, cover_source, cover_path, cover_rev,
/// cover_fingerprint, cover_style, updated_at. `track_ids` is left empty for the
/// caller to fill in (it requires a separate query).
fn project_from_row(row: &Row) -> rusqlite::Result<Project> {
    let cover_source: Option<String> = row.get(3)?;
    let cover_path: Option<String> = row.get(4)?;
    let cover_rev: Option<String> = row.get(5)?;
    let cover_fingerprint: Option<String> = row.get(6)?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        cover_image: file_ref_from_parts(cover_source, cover_path, cover_rev, cover_fingerprint),
        cover_style: row.get(7)?,
        track_ids: Vec::new(),
        updated_at: row.get(8)?,
    })
}

/// Expects columns in order: id, project_id, title, default_version_id, cover_source,
/// cover_path, cover_rev, cover_fingerprint.
fn track_from_row(row: &Row) -> rusqlite::Result<Track> {
    let cover_source: Option<String> = row.get(4)?;
    let cover_path: Option<String> = row.get(5)?;
    let cover_rev: Option<String> = row.get(6)?;
    let cover_fingerprint: Option<String> = row.get(7)?;
    Ok(Track {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        default_version_id: row.get(3)?,
        cover_image: file_ref_from_parts(cover_source, cover_path, cover_rev, cover_fingerprint),
    })
}

/// Expects columns in order: id, track_id, label, file_source, file_path, file_rev,
/// file_fingerprint, duration_seconds, bpm, key, peak_data_path, created_at, dropbox_path.
fn version_from_row(row: &Row) -> rusqlite::Result<Version> {
    Ok(Version {
        id: row.get(0)?,
        track_id: row.get(1)?,
        label: row.get(2)?,
        file: FileRef {
            source: row.get(3)?,
            path: row.get(4)?,
            rev: row.get(5)?,
            fingerprint: row.get(6)?,
        },
        duration_seconds: row.get(7)?,
        bpm: row.get(8)?,
        key: row.get(9)?,
        peak_data_path: row.get(10)?,
        created_at: row.get(11)?,
        dropbox_path: row.get(12)?,
    })
}

/// Fetches a single version by id — used by the Dropbox upload/share flow.
pub fn get_version(conn: &Connection, version_id: &str) -> Result<Version, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, track_id, label, file_source, file_path, file_rev, file_fingerprint, duration_seconds, bpm, key, peak_data_path, created_at, dropbox_path
             FROM versions WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_row(params![version_id], version_from_row)
        .map_err(|e| format!("version not found: {e}"))
}

/// Records where a version now lives in the Dropbox app folder (after upload).
pub fn set_version_dropbox_location(
    conn: &Connection,
    version_id: &str,
    dropbox_path: &str,
    dropbox_rev: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE versions SET dropbox_path = ?1, file_rev = ?2 WHERE id = ?3",
        params![dropbox_path, dropbox_rev, version_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn track_ids_for_project(conn: &Connection, project_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM tracks WHERE project_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

fn tracks_for_project(conn: &Connection, project_id: &str) -> Result<Vec<Track>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, title, default_version_id, cover_source, cover_path, cover_rev, cover_fingerprint
             FROM tracks WHERE project_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map(params![project_id], track_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

fn versions_for_track(conn: &Connection, track_id: &str) -> Result<Vec<Version>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, track_id, label, file_source, file_path, file_rev, file_fingerprint, duration_seconds, bpm, key, peak_data_path, created_at, dropbox_path
             FROM versions WHERE track_id = ?1 ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map(params![track_id], version_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

fn playlist_items_for(conn: &Connection, playlist_id: &str) -> Result<Vec<PlaylistItem>, String> {
    let mut stmt = conn
        .prepare("SELECT track_id, version_id FROM playlist_items WHERE playlist_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map(params![playlist_id], |row| {
            Ok(PlaylistItem {
                track_id: row.get(0)?,
                version_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

// ---------- Dropbox connection identity (no tokens here — see dropbox.rs) ----------
//
// This table stores only non-secret identity info (who's connected), so `get_project_detail`-style
// reads never touch anything sensitive. The actual access/refresh tokens live exclusively in the
// OS keychain, managed entirely by `dropbox.rs`.

pub fn save_dropbox_connection(
    conn: &Connection,
    info: &crate::models::DropboxAccountInfo,
) -> Result<(), String> {
    let connected_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO dropbox_connection (id, account_id, email, display_name, connected_at)
         VALUES (1, ?1, ?2, ?3, ?4)",
        params![info.account_id, info.email, info.display_name, connected_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_dropbox_connection(
    conn: &Connection,
) -> Result<Option<crate::models::DropboxAccountInfo>, String> {
    conn.query_row(
        "SELECT account_id, email, display_name FROM dropbox_connection WHERE id = 1",
        [],
        |row| {
            Ok(crate::models::DropboxAccountInfo {
                account_id: row.get(0)?,
                email: row.get(1)?,
                display_name: row.get(2)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| {
        if e == rusqlite::Error::QueryReturnedNoRows {
            Ok(None)
        } else {
            Err(e.to_string())
        }
    })
}

pub fn clear_dropbox_connection(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM dropbox_connection WHERE id = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Projects ----------

#[tauri::command]
pub fn list_projects(state: State<DbState>) -> Result<Vec<Project>, String> {
    let conn = state.0.lock();

    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, cover_source, cover_path, cover_rev, cover_fingerprint, cover_style, updated_at
             FROM projects ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let mut projects: Vec<Project> = stmt
        .query_map([], project_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    for project in projects.iter_mut() {
        project.track_ids = track_ids_for_project(&conn, &project.id)?;
    }

    Ok(projects)
}

#[tauri::command]
pub fn create_project(state: State<DbState>, name: String, kind: String) -> Result<Project, String> {
    let conn = state.0.lock();

    let id = uuid::Uuid::new_v4().to_string();
    let updated_at = chrono::Utc::now().to_rfc3339();
    let cover_style = "individual".to_string();

    let sort_order: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO projects (id, name, kind, cover_style, sort_order, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, kind, cover_style, sort_order, updated_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(Project {
        id,
        name,
        kind,
        cover_image: None,
        cover_style,
        track_ids: Vec::new(),
        updated_at,
    })
}

#[tauri::command]
pub fn set_project_cover_style(state: State<DbState>, project_id: String, style: String) -> Result<(), String> {
    if style != "album" && style != "individual" {
        return Err(format!("invalid cover style: {style}"));
    }

    let conn = state.0.lock();
    conn.execute(
        "UPDATE projects SET cover_style = ?1 WHERE id = ?2",
        params![style, project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Computes a fingerprint string ("{size}:{mtime_secs}") for a local file, used to
/// detect when a re-linked/re-imported file has actually changed. `None` if the
/// file's metadata can't be read (kept as a soft failure, mirroring `import_local_files`).
fn local_fingerprint(path: &str) -> Option<String> {
    std::fs::metadata(path).ok().map(|meta| {
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{}:{}", meta.len(), mtime_secs)
    })
}

#[tauri::command]
pub fn set_project_cover_image(
    state: State<DbState>,
    project_id: String,
    source: String,
    path: String,
) -> Result<(), String> {
    let conn = state.0.lock();
    let fingerprint = local_fingerprint(&path);
    conn.execute(
        "UPDATE projects SET cover_source = ?1, cover_path = ?2, cover_fingerprint = ?3 WHERE id = ?4",
        params![source, path, fingerprint, project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_track_cover_image(
    state: State<DbState>,
    track_id: String,
    source: String,
    path: String,
) -> Result<(), String> {
    let conn = state.0.lock();
    let fingerprint = local_fingerprint(&path);
    conn.execute(
        "UPDATE tracks SET cover_source = ?1, cover_path = ?2, cover_fingerprint = ?3 WHERE id = ?4",
        params![source, path, fingerprint, track_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_project_detail(state: State<DbState>, project_id: String) -> Result<ProjectDetail, String> {
    let conn = state.0.lock();

    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, cover_source, cover_path, cover_rev, cover_fingerprint, cover_style, updated_at
             FROM projects WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut project = stmt
        .query_row(params![project_id], project_from_row)
        .map_err(|e| format!("project not found: {e}"))?;
    drop(stmt);

    let tracks = tracks_for_project(&conn, &project_id)?;
    project.track_ids = tracks.iter().map(|t| t.id.clone()).collect();

    let mut versions_by_track = HashMap::new();
    for track in &tracks {
        let versions = versions_for_track(&conn, &track.id)?;
        versions_by_track.insert(track.id.clone(), versions);
    }

    Ok(ProjectDetail {
        project,
        tracks,
        versions_by_track,
    })
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
    let conn = state.0.lock();

    let mut next_sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tracks WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut created_tracks = Vec::new();

    for path in file_paths {
        let title = std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());

        let duration_seconds = waveform::probe_duration_seconds(path.clone()).unwrap_or(0.0);

        let fingerprint = std::fs::metadata(&path).ok().map(|meta| {
            let mtime_secs = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}:{}", meta.len(), mtime_secs)
        });

        let track_id = uuid::Uuid::new_v4().to_string();
        let version_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO tracks (id, project_id, title, default_version_id, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![track_id, project_id, title, version_id, next_sort_order],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO versions (id, track_id, label, file_source, file_path, file_fingerprint, duration_seconds, created_at)
             VALUES (?1, ?2, 'Original', 'local', ?3, ?4, ?5, ?6)",
            params![version_id, track_id, path, fingerprint, duration_seconds, created_at],
        )
        .map_err(|e| e.to_string())?;

        next_sort_order += 1;

        created_tracks.push(Track {
            id: track_id,
            project_id: project_id.clone(),
            title,
            default_version_id: Some(version_id),
            cover_image: None,
        });
    }

    Ok(created_tracks)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportVersionInput {
    pub label: String,
    pub path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportGroupInput {
    pub title: String,
    pub versions: Vec<ImportVersionInput>,
    /// Index into `versions` that should become the track's default (master) version.
    pub default_version_index: usize,
}

/// Imports drag-and-dropped files that have already been grouped client-side (e.g. by
/// the filename-based "Track master v1/v2/v3" heuristic) into one Track per group, with
/// one Version per file in that group. Complements `import_local_files`, which always
/// creates a separate track per file — this is what the drag & drop flow uses instead.
#[tauri::command]
pub fn import_grouped_files(
    state: State<DbState>,
    project_id: String,
    groups: Vec<ImportGroupInput>,
) -> Result<Vec<Track>, String> {
    let conn = state.0.lock();

    let mut next_sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tracks WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut created_tracks = Vec::new();

    for group in groups {
        if group.versions.is_empty() {
            continue;
        }
        let default_index = group.default_version_index.min(group.versions.len() - 1);

        let track_id = uuid::Uuid::new_v4().to_string();
        let mut default_version_id: Option<String> = None;

        // Insert the track first with no default yet — versions reference it via FK,
        // and we only know the default version's id once we've created it below.
        conn.execute(
            "INSERT INTO tracks (id, project_id, title, sort_order) VALUES (?1, ?2, ?3, ?4)",
            params![track_id, project_id, group.title, next_sort_order],
        )
        .map_err(|e| e.to_string())?;

        for (i, version_input) in group.versions.into_iter().enumerate() {
            let version_id = uuid::Uuid::new_v4().to_string();
            let created_at = chrono::Utc::now().to_rfc3339();
            let duration_seconds =
                waveform::probe_duration_seconds(version_input.path.clone()).unwrap_or(0.0);
            let fingerprint = local_fingerprint(&version_input.path);

            conn.execute(
                "INSERT INTO versions (id, track_id, label, file_source, file_path, file_fingerprint, duration_seconds, created_at)
                 VALUES (?1, ?2, ?3, 'local', ?4, ?5, ?6, ?7)",
                params![
                    version_id,
                    track_id,
                    version_input.label,
                    version_input.path,
                    fingerprint,
                    duration_seconds,
                    created_at
                ],
            )
            .map_err(|e| e.to_string())?;

            if i == default_index {
                default_version_id = Some(version_id);
            }
        }

        conn.execute(
            "UPDATE tracks SET default_version_id = ?1 WHERE id = ?2",
            params![default_version_id, track_id],
        )
        .map_err(|e| e.to_string())?;

        next_sort_order += 1;

        created_tracks.push(Track {
            id: track_id,
            project_id: project_id.clone(),
            title: group.title,
            default_version_id,
            cover_image: None,
        });
    }

    Ok(created_tracks)
}

/// Dropbox-flavored variant of the track+version insert done by
/// `import_local_files`: creates one Track + one "Original" Version for a
/// single file that has already been downloaded to `local_cache_path`, but
/// with the version's `file_source` set to `"dropbox"` instead of
/// `"local"`. Called from `dropbox.rs::dropbox_import_file` after it has
/// downloaded the file from the Dropbox content API. Not a `#[tauri::command]`
/// itself — `dropbox_import_file` is the command, this is its DB half.
pub fn insert_dropbox_track(
    conn: &Connection,
    project_id: &str,
    file_name: &str,
    local_cache_path: &str,
    dropbox_path: &str,
    dropbox_rev: &str,
    duration_seconds: f64,
) -> Result<Track, String> {
    let title = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string());

    let fingerprint = local_fingerprint(local_cache_path);

    let next_sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tracks WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let track_id = uuid::Uuid::new_v4().to_string();
    let version_id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO tracks (id, project_id, title, default_version_id, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![track_id, project_id, title, version_id, next_sort_order],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO versions (id, track_id, label, file_source, file_path, file_rev, file_fingerprint, duration_seconds, created_at, dropbox_path)
         VALUES (?1, ?2, 'Original', 'dropbox', ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            version_id,
            track_id,
            local_cache_path,
            dropbox_rev,
            fingerprint,
            duration_seconds,
            created_at,
            dropbox_path
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(Track {
        id: track_id,
        project_id: project_id.to_string(),
        title,
        default_version_id: Some(version_id),
        cover_image: None,
    })
}

#[tauri::command]
pub fn list_versions(state: State<DbState>, track_id: String) -> Result<Vec<Version>, String> {
    let conn = state.0.lock();
    versions_for_track(&conn, &track_id)
}

#[tauri::command]
pub fn set_default_version(state: State<DbState>, track_id: String, version_id: String) -> Result<(), String> {
    let conn = state.0.lock();

    let belongs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM versions WHERE id = ?1 AND track_id = ?2",
            params![version_id, track_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if belongs == 0 {
        return Err(format!(
            "version {version_id} does not belong to track {track_id}"
        ));
    }

    conn.execute(
        "UPDATE tracks SET default_version_id = ?1 WHERE id = ?2",
        params![version_id, track_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------- Playlists & favorites ----------

#[tauri::command]
pub fn list_playlists(state: State<DbState>) -> Result<Vec<Playlist>, String> {
    let conn = state.0.lock();

    let mut stmt = conn
        .prepare("SELECT id, name FROM playlists ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let mut playlists: Vec<Playlist> = stmt
        .query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                items: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    for playlist in playlists.iter_mut() {
        playlist.items = playlist_items_for(&conn, &playlist.id)?;
    }

    Ok(playlists)
}

#[tauri::command]
pub fn create_playlist(state: State<DbState>, name: String) -> Result<Playlist, String> {
    let conn = state.0.lock();

    let id = uuid::Uuid::new_v4().to_string();

    let sort_order: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM playlists", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO playlists (id, name, sort_order) VALUES (?1, ?2, ?3)",
        params![id, name, sort_order],
    )
    .map_err(|e| e.to_string())?;

    Ok(Playlist {
        id,
        name,
        items: Vec::new(),
    })
}

#[tauri::command]
pub fn add_to_playlist(
    state: State<DbState>,
    playlist_id: String,
    track_id: String,
    version_id: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock();

    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM playlist_items WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO playlist_items (playlist_id, track_id, version_id, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![playlist_id, track_id, version_id, sort_order],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn remove_from_playlist(
    state: State<DbState>,
    playlist_id: String,
    track_id: String,
    version_id: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock();
    conn.execute(
        "DELETE FROM playlist_items WHERE playlist_id = ?1 AND track_id = ?2 AND version_id IS ?3",
        params![playlist_id, track_id, version_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_playlist(state: State<DbState>, playlist_id: String) -> Result<(), String> {
    let conn = state.0.lock();
    // Deleted explicitly rather than relying on the `ON DELETE CASCADE` FK, since
    // rusqlite/SQLite only enforces that when `PRAGMA foreign_keys = ON` has been
    // set on the connection, which this app doesn't currently do.
    conn.execute(
        "DELETE FROM playlist_items WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_playlist(state: State<DbState>, playlist_id: String, name: String) -> Result<(), String> {
    let conn = state.0.lock();
    conn.execute(
        "UPDATE playlists SET name = ?1 WHERE id = ?2",
        params![name, playlist_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolves one (track_id, pinned_version_id) pair into a full `PlaylistTrackEntry`
/// (track + version + owning project's identity/cover). Used by both real playlists
/// and the pinned Favorites pseudo-playlist, since both are flat, cross-project track
/// lists. Returns `Ok(None)` rather than an error if the track no longer exists (e.g.
/// a stale playlist/favorite entry left behind — there's no track deletion command yet,
/// but tolerating this is cheap and matches this codebase's soft-failure style).
fn resolve_playlist_entry(
    conn: &Connection,
    track_id: &str,
    pinned_version_id: Option<&str>,
) -> Result<Option<PlaylistTrackEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, title, default_version_id, cover_source, cover_path, cover_rev, cover_fingerprint
             FROM tracks WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let track = match stmt.query_row(params![track_id], track_from_row) {
        Ok(t) => t,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    drop(stmt);

    let version_id = pinned_version_id
        .map(|s| s.to_string())
        .or_else(|| track.default_version_id.clone());
    let version = match version_id {
        Some(vid) => get_version(conn, &vid).ok(),
        None => None,
    };

    let mut stmt = conn
        .prepare(
            "SELECT name, cover_source, cover_path, cover_rev, cover_fingerprint FROM projects WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let (project_name, project_cover) = match stmt.query_row(params![track.project_id], |row| {
        let name: String = row.get(0)?;
        let cover_source: Option<String> = row.get(1)?;
        let cover_path: Option<String> = row.get(2)?;
        let cover_rev: Option<String> = row.get(3)?;
        let cover_fingerprint: Option<String> = row.get(4)?;
        Ok((name, file_ref_from_parts(cover_source, cover_path, cover_rev, cover_fingerprint)))
    }) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    Ok(Some(PlaylistTrackEntry {
        project_id: track.project_id.clone(),
        project_name,
        project_cover,
        track,
        version,
    }))
}

#[tauri::command]
pub fn get_playlist_detail(
    state: State<DbState>,
    playlist_id: String,
) -> Result<Vec<PlaylistTrackEntry>, String> {
    let conn = state.0.lock();
    let items = playlist_items_for(&conn, &playlist_id)?;
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        if let Some(entry) = resolve_playlist_entry(&conn, &item.track_id, item.version_id.as_deref())? {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_favorite_tracks(state: State<DbState>) -> Result<Vec<PlaylistTrackEntry>, String> {
    let conn = state.0.lock();

    let mut stmt = conn
        .prepare("SELECT track_id, version_id FROM favorites ORDER BY favorited_at DESC")
        .map_err(|e| e.to_string())?;
    let favorites: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut entries = Vec::with_capacity(favorites.len());
    for (track_id, version_id) in favorites {
        if let Some(entry) = resolve_playlist_entry(&conn, &track_id, version_id.as_deref())? {
            entries.push(entry);
        }
    }
    Ok(entries)
}

// ---------- Storage settings & local downloads ----------

/// Reads the configured download directory, or computes+persists the default
/// (`<audio dir>/Session Downloads`) the first time nothing has been configured
/// yet, so it stays stable across restarts until the user picks something else.
/// Shared by the `get_download_dir` command and `download_version`, both of
/// which already hold the DB lock — takes `&Connection` rather than `State` so
/// neither has to re-lock (or rely on `State` being `Clone`).
fn resolve_download_dir(conn: &Connection, app_handle: &AppHandle) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row("SELECT download_dir FROM app_settings WHERE id = 1", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    if let Some(dir) = existing {
        return Ok(dir);
    }

    let default_dir = app_handle
        .path()
        .audio_dir()
        .map_err(|e| format!("could not resolve the audio directory: {e}"))?
        .join("Session Downloads");
    std::fs::create_dir_all(&default_dir)
        .map_err(|e| format!("failed to create the default download directory: {e}"))?;
    let default_dir_str = default_dir.to_string_lossy().into_owned();

    conn.execute(
        "INSERT OR REPLACE INTO app_settings (id, download_dir) VALUES (1, ?1)",
        params![default_dir_str],
    )
    .map_err(|e| e.to_string())?;

    Ok(default_dir_str)
}

#[tauri::command]
pub fn get_download_dir(state: State<DbState>, app_handle: AppHandle) -> Result<String, String> {
    let conn = state.0.lock();
    resolve_download_dir(&conn, &app_handle)
}

#[tauri::command]
pub fn set_download_dir(state: State<DbState>, path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("can't use that folder: {e}"))?;
    let conn = state.0.lock();
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (id, download_dir) VALUES (1, ?1)",
        params![path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies a version's audio file into the configured download directory and flips
/// it to a `"local"`-sourced file living there. Meaningful for `"dropbox"`-sourced
/// versions (whose file currently lives in the hidden, app-internal `dropbox_cache`
/// directory — see `dropbox.rs` — which is a fine transient cache but not something
/// the user can see or rely on surviving a future cache-eviction policy). Already-
/// local versions are returned unchanged rather than erroring, so the frontend can
/// call this unconditionally without checking `file.source` first.
#[tauri::command]
pub fn download_version(
    state: State<DbState>,
    app_handle: AppHandle,
    version_id: String,
) -> Result<Version, String> {
    let conn = state.0.lock();
    let version = get_version(&conn, &version_id)?;
    if version.file.source == "local" {
        return Ok(version);
    }

    let title: String = conn
        .query_row(
            "SELECT title FROM tracks WHERE id = ?1",
            params![version.track_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let download_dir = resolve_download_dir(&conn, &app_handle)?;

    let ext = std::path::Path::new(&version.file.path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dat");
    let safe_title: String = title
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let file_name = if version.label.eq_ignore_ascii_case("original") {
        format!("{safe_title}.{ext}")
    } else {
        format!("{safe_title} ({}).{ext}", version.label)
    };
    let dest_path = std::path::Path::new(&download_dir).join(file_name);

    std::fs::copy(&version.file.path, &dest_path)
        .map_err(|e| format!("failed to download '{}': {e}", title))?;
    let dest_path_str = dest_path.to_string_lossy().into_owned();
    let fingerprint = local_fingerprint(&dest_path_str);

    conn.execute(
        "UPDATE versions SET file_source = 'local', file_path = ?1, file_fingerprint = ?2 WHERE id = ?3",
        params![dest_path_str, fingerprint, version_id],
    )
    .map_err(|e| e.to_string())?;

    get_version(&conn, &version_id)
}

#[tauri::command]
pub fn list_favorites(state: State<DbState>) -> Result<Vec<Favorite>, String> {
    let conn = state.0.lock();

    let mut stmt = conn
        .prepare("SELECT track_id, version_id, favorited_at FROM favorites ORDER BY favorited_at")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([], |row| {
            Ok(Favorite {
                track_id: row.get(0)?,
                version_id: row.get(1)?,
                favorited_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn toggle_favorite(
    state: State<DbState>,
    track_id: String,
    version_id: Option<String>,
) -> Result<bool, String> {
    let conn = state.0.lock();

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM favorites WHERE track_id = ?1 AND version_id IS ?2",
            params![track_id, version_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if exists > 0 {
        conn.execute(
            "DELETE FROM favorites WHERE track_id = ?1 AND version_id IS ?2",
            params![track_id, version_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        let favorited_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO favorites (track_id, version_id, favorited_at) VALUES (?1, ?2, ?3)",
            params![track_id, version_id, favorited_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    }
}
