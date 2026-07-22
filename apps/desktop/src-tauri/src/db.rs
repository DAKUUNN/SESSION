use crate::models::{FileRef, Favorite, Playlist, PlaylistItem, Project, ProjectDetail, Track, Version};
use crate::waveform;
use parking_lot::Mutex;
use rusqlite::{params, Connection, Row};
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
        CREATE TABLE IF NOT EXISTS dropbox_connection (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            account_id TEXT NOT NULL,
            email TEXT NOT NULL,
            display_name TEXT NOT NULL,
            connected_at TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| e.to_string())?;
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
/// file_fingerprint, duration_seconds, bpm, key, peak_data_path, created_at.
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
    })
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
            "SELECT id, track_id, label, file_source, file_path, file_rev, file_fingerprint, duration_seconds, bpm, key, peak_data_path, created_at
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
