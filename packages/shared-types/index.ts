/** A reference to a file that may live on disk or in the user's Dropbox.
 *  Local-first: every audio file and cover image is one of these. */
export interface FileRef {
  source: "local" | "dropbox";
  /** Absolute local path, or the Dropbox path when source is "dropbox". */
  path: string;
  /** Dropbox content revision, used to detect when a synced file has changed. */
  rev?: string;
  /** Content fingerprint (size + mtime hash) used to re-link a moved local file. */
  fingerprint?: string;
}

export interface Version {
  id: string;
  trackId: string;
  /** "Demo", "Mix 2", "Master", etc. — free text, artist-defined. */
  label: string;
  file: FileRef;
  durationSeconds: number;
  bpm?: number;
  key?: string;
  /** Path to cached downsampled peak data for waveform rendering. */
  peakDataPath?: string;
  createdAt: string;
  /** Path in the Dropbox app folder once uploaded/synced there (needed for share links). */
  dropboxPath?: string | null;
}

export interface Track {
  id: string;
  projectId: string;
  title: string;
  defaultVersionId: string | null;
  /** Falls back to the parent Project's cover when unset. */
  coverImage?: FileRef;
}

export type ProjectKind = "single" | "ep" | "album" | "mixtape";
export type CoverStyle = "album" | "individual";

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  coverImage?: FileRef;
  /** "album": one hero cover for the whole release, numbered tracklist.
   *  "individual": each track keeps its own cover, playlist-style. */
  coverStyle: CoverStyle;
  trackIds: string[];
  updatedAt: string;
}

export interface PlaylistItem {
  trackId: string;
  /** Pins a specific version; omitted means "follow the track's default version". */
  versionId?: string;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
}

export interface Favorite {
  trackId: string;
  versionId?: string;
  favoritedAt: string;
}

/** One resolved, playable row in a flat cross-project track list — used by both
 *  real playlists and the pinned Favorites pseudo-playlist. */
export interface PlaylistTrackEntry {
  track: Track;
  /** The pinned version if set, otherwise the track's current default version. */
  version: Version | null;
  projectId: string;
  projectName: string;
  projectCover?: FileRef;
}

export interface PeakData {
  /** Downsampled min/max pairs, one per bucket, values in [-1, 1]. */
  peaks: number[];
}
