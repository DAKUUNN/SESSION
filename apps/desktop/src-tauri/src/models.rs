use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub source: String, // "local" | "dropbox"
    pub path: String,
    pub rev: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub track_id: String,
    pub label: String,
    pub file: FileRef,
    pub duration_seconds: f64,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub peak_data_path: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub default_version_id: Option<String>,
    pub cover_image: Option<FileRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: String, // "single" | "ep" | "album" | "mixtape"
    pub cover_image: Option<FileRef>,
    pub cover_style: String, // "album" | "individual"
    pub track_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub track_id: String,
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub items: Vec<PlaylistItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub track_id: String,
    pub version_id: Option<String>,
    pub favorited_at: String,
}

/// Full project detail bundle: the project plus its tracks and each track's versions,
/// shaped so the frontend can render a project screen from one call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub project: Project,
    pub tracks: Vec<Track>,
    pub versions_by_track: std::collections::HashMap<String, Vec<Version>>,
}
