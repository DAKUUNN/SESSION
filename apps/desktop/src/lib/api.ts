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

export interface DropboxAccountInfo {
  accountId: string;
  email: string;
  displayName: string;
}

export interface DropboxFileEntry {
  name: string;
  path: string;
  rev: string;
  size: number;
}

export interface LicenseInfo {
  key: string;
  instanceId: string;
  /** Lemon Squeezy license status: "active", "inactive", "expired", "disabled". */
  status: string;
  productName?: string | null;
  customerEmail?: string | null;
  activatedAt: string;
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

  dropboxConnect: () => invoke<DropboxAccountInfo>("dropbox_connect"),
  dropboxGetConnection: () => invoke<DropboxAccountInfo | null>("dropbox_get_connection"),
  dropboxDisconnect: () => invoke<void>("dropbox_disconnect"),
  dropboxListAppFolder: () => invoke<DropboxFileEntry[]>("dropbox_list_app_folder"),
  dropboxImportFile: (
    projectId: string,
    dropboxPath: string,
    dropboxRev: string,
    fileName: string,
  ) =>
    invoke<Track>("dropbox_import_file", {
      projectId,
      dropboxPath,
      dropboxRev,
      fileName,
    }),

  dropboxUploadVersion: (versionId: string) =>
    invoke<Version>("dropbox_upload_version", { versionId }),
  dropboxGetRefreshToken: () => invoke<string>("dropbox_get_refresh_token"),

  licenseActivate: (licenseKey: string) =>
    invoke<LicenseInfo>("license_activate", { licenseKey }),
  licenseGet: () => invoke<LicenseInfo | null>("license_get"),
  licenseValidate: () => invoke<LicenseInfo>("license_validate"),
  licenseDeactivate: () => invoke<void>("license_deactivate"),

  /** Resolves with the full callback URL once the user clicks the emailed
   *  sign-in link (or rejects after ~5 minutes). Call right after
   *  `sendSignInLinkToEmail` so the loopback listener is already bound. */
  authWaitForEmailLinkCallback: () =>
    invoke<string>("auth_wait_for_email_link_callback"),
};
