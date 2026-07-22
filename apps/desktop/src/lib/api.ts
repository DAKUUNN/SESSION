/**
 * Typed wrappers around the Tauri backend commands.
 *
 * Every function here maps 1:1 to a `#[tauri::command]` registered in
 * `src-tauri/src/lib.rs`. Keeping them in one place means the rest of the
 * app never touches `invoke("...")` string literals directly.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Favorite,
  Playlist,
  Project,
  ProjectKind,
  Track,
  Version,
} from "@session/shared-types";

export interface ProjectDetail {
  project: Project;
  tracks: Track[];
  versionsByTrack: Record<string, Version[]>;
}

export interface ImportGroupVersionInput {
  label: string;
  path: string;
}

export interface ImportGroupInput {
  title: string;
  versions: ImportGroupVersionInput[];
  defaultVersionIndex: number;
}

export interface PlaybackStatus {
  positionSeconds: number;
  durationSeconds: number;
  isPlaying: boolean;
}

export const api = {
  listProjects: () => invoke<Project[]>("list_projects"),

  createProject: (name: string, kind: ProjectKind | string) =>
    invoke<Project>("create_project", { name, kind }),

  setProjectCoverStyle: (projectId: string, style: string) =>
    invoke<void>("set_project_cover_style", { projectId, style }),

  setProjectCoverImage: (projectId: string, source: string, path: string) =>
    invoke<void>("set_project_cover_image", { projectId, source, path }),

  setTrackCoverImage: (trackId: string, source: string, path: string) =>
    invoke<void>("set_track_cover_image", { trackId, source, path }),

  getProjectDetail: (projectId: string) =>
    invoke<ProjectDetail>("get_project_detail", { projectId }),

  importLocalFiles: (projectId: string, filePaths: string[]) =>
    invoke<Track[]>("import_local_files", { projectId, filePaths }),

  importGroupedFiles: (projectId: string, groups: ImportGroupInput[]) =>
    invoke<Track[]>("import_grouped_files", { projectId, groups }),

  listVersions: (trackId: string) =>
    invoke<Version[]>("list_versions", { trackId }),

  setDefaultVersion: (trackId: string, versionId: string) =>
    invoke<void>("set_default_version", { trackId, versionId }),

  listPlaylists: () => invoke<Playlist[]>("list_playlists"),

  createPlaylist: (name: string) =>
    invoke<Playlist>("create_playlist", { name }),

  addToPlaylist: (playlistId: string, trackId: string, versionId?: string) =>
    invoke<void>("add_to_playlist", { playlistId, trackId, versionId }),

  listFavorites: () => invoke<Favorite[]>("list_favorites"),

  toggleFavorite: (trackId: string, versionId?: string) =>
    invoke<boolean>("toggle_favorite", { trackId, versionId }),

  generatePeaks: (path: string, bucketCount: number) =>
    invoke<number[]>("generate_peaks_cmd", { path, bucketCount }),

  audioLoad: (path: string) => invoke<void>("audio_load", { path }),
  audioPlay: () => invoke<void>("audio_play"),
  audioPause: () => invoke<void>("audio_pause"),
  audioSeek: (positionSeconds: number) =>
    invoke<void>("audio_seek", { positionSeconds }),
  audioSetVolume: (volume: number) =>
    invoke<void>("audio_set_volume", { volume }),
  audioGetStatus: () => invoke<PlaybackStatus>("audio_get_status"),
};
