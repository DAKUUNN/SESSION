import { useCallback, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Playlist, Project, Track, Version } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { TrackRow } from "./TrackRow";
import { DownloadIcon, EditIcon, PauseIcon, PlayIcon, ShareIcon, ShuffleIcon } from "./icons";
import { formatDuration, formatRelativeTime } from "../lib/format";
import type { PlayerApi } from "../hooks/usePlayer";
import { useFileDrop } from "../hooks/useFileDrop";
import "./MainPanel.css";

function defaultVersionFor(track: Track, versionsByTrack: Record<string, Version[]>) {
  const versions = versionsByTrack[track.id] ?? [];
  return versions.find((v) => v.id === track.defaultVersionId) ?? versions[0];
}

interface MainPanelProps {
  project: Project;
  tracks: Track[];
  versionsByTrack: Record<string, Version[]>;
  isFavorite: (trackId: string, versionId?: string) => boolean;
  onToggleFavorite: (trackId: string, versionId?: string) => void;
  player: PlayerApi;
  /** Persists (and optimistically reflects) a track's new default/master version. */
  onSwitchDefaultVersion: (trackId: string, versionId: string) => void;
  /** Audio files dropped from Finder onto the panel, already filtered to audio extensions. */
  onImportPaths: (paths: string[]) => void;
  /** Opens the New/Edit Project modal in edit mode for this project. */
  onEditProject: () => void;
  /** Opens a native image picker and sets the project's hero cover. */
  onAddProjectCover: () => void;
  /** Opens a native image picker and sets one track's own cover (individual mode). */
  onAddTrackCover: (trackId: string) => void;
  /** Opens the share-link modal for one track + its current default version. */
  onShare: (track: Track, version: Version) => void;
  /** Opens the album-share modal for the whole project. */
  onShareAlbum: () => void;
  /** All playlists, for each row's "add to playlist" menu. */
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, trackId: string, versionId?: string) => void;
  onCreatePlaylistWithTrack: (name: string, trackId: string, versionId?: string) => void;
  /** Downloads a dropbox-sourced version into the configured local download folder. */
  onDownloadVersion: (versionId: string) => void;
  /** The versionId currently mid-download, if any (disables that row's button). */
  downloadingVersionId: string | null;
  /** Downloads every track's current version in this project — the whole-project counterpart of onDownloadVersion. */
  onDownloadProject: () => void;
  /** Set while onDownloadProject is running; also doubles as its status label ("Downloading 2 of 5…"). */
  projectDownloadLabel: string | null;
}

export function MainPanel({
  project,
  tracks,
  versionsByTrack,
  isFavorite,
  onToggleFavorite,
  player,
  onSwitchDefaultVersion,
  onImportPaths,
  onEditProject,
  onAddProjectCover,
  onAddTrackCover,
  onShare,
  onShareAlbum,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWithTrack,
  onDownloadVersion,
  downloadingVersionId,
  onDownloadProject,
  projectDownloadLabel,
}: MainPanelProps) {
  const { nowPlaying, status, loadAndPlay, switchVersion, seek } = player;

  const dropState = useFileDrop({ onDropFiles: onImportPaths });

  const totalDuration = useMemo(
    () =>
      tracks.reduce((sum, t) => {
        const v = defaultVersionFor(t, versionsByTrack);
        return sum + (v?.durationSeconds ?? 0);
      }, 0),
    [tracks, versionsByTrack],
  );

  // Only worth offering when at least one track still streams from Dropbox
  // rather than already playing from a local copy.
  const hasDownloadableVersions = useMemo(
    () => tracks.some((t) => defaultVersionFor(t, versionsByTrack)?.file.source === "dropbox"),
    [tracks, versionsByTrack],
  );

  const trackIds = useMemo(() => new Set(tracks.map((t) => t.id)), [tracks]);
  const projectIsCurrent = !!nowPlaying && trackIds.has(nowPlaying.trackId);

  function activate(track: Track) {
    const version = defaultVersionFor(track, versionsByTrack);
    if (!version) return;
    loadAndPlay(
      {
        trackId: track.id,
        versionId: version.id,
        title: track.title,
        versionLabel: version.label,
        cover: track.coverImage ?? project.coverImage,
      },
      version.file.path,
    );
  }

  function handleHeroPlay() {
    if (projectIsCurrent) {
      player.togglePlay();
      return;
    }
    const first = tracks[0];
    if (first) activate(first);
  }

  function handleShuffle() {
    if (tracks.length === 0) return;
    const pick = tracks[Math.floor(Math.random() * tracks.length)];
    activate(pick);
  }

  // Switching a track's master version: if that exact track is the one
  // currently loaded in the player, continue playback seamlessly from the
  // same position (via usePlayer's switchVersion) instead of restarting.
  // Either way, the new default is persisted (and optimistically reflected)
  // through onSwitchDefaultVersion.
  const handleSwitchVersion = useCallback(
    (track: Track, versionId: string) => {
      const versions = versionsByTrack[track.id] ?? [];
      const target = versions.find((v) => v.id === versionId);
      if (!target || target.id === track.defaultVersionId) return;

      if (nowPlaying?.trackId === track.id) {
        const resumeSeconds = status.positionSeconds;
        const resumePlaying = status.isPlaying;
        switchVersion(
          {
            trackId: track.id,
            versionId: target.id,
            title: track.title,
            versionLabel: target.label,
            cover: track.coverImage ?? project.coverImage,
          },
          target.file.path,
          resumeSeconds,
          resumePlaying,
        );
      }

      onSwitchDefaultVersion(track.id, target.id);
    },
    [versionsByTrack, nowPlaying, status, switchVersion, project.coverImage, onSwitchDefaultVersion],
  );

  return (
    <section className="main-panel">
      {dropState === "hover" ? (
        <div className="main-panel__drop-overlay">
          <div className="main-panel__drop-overlay-text">Drop to import</div>
        </div>
      ) : null}
      <div className="main-panel__scroll">
        {project.coverStyle === "album" ? (
          <div className="hero" key={project.id}>
            {project.coverImage?.path ? (
              <div
                className="hero__glow ambient-glow"
                style={{ backgroundImage: `url(${convertFileSrc(project.coverImage.path)})` }}
              />
            ) : null}
            <div className="hero__cover">
              <CoverThumb
                cover={project.coverImage}
                size={148}
                showAddAffordance={!project.coverImage?.path}
                onAdd={onAddProjectCover}
              />
            </div>
            <div className="hero__info">
              <div className="hero__eyebrow">{project.kind}</div>
              <div className="hero__title-row">
                <h1 className="hero__title">{project.name}</h1>
                <button
                  className="icon-btn hero__edit-btn"
                  onClick={onEditProject}
                  title="Edit project"
                >
                  <EditIcon />
                </button>
              </div>
              <div className="hero__meta tabular">
                {tracks.length} track{tracks.length === 1 ? "" : "s"},{" "}
                {formatDuration(totalDuration)}, updated {formatRelativeTime(project.updatedAt)}
              </div>
              <div className="hero__actions">
                <button className="hero__play" onClick={handleHeroPlay} title="Play">
                  {projectIsCurrent && status.isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button className="icon-btn hero__icon-btn" onClick={handleShuffle} title="Shuffle">
                  <ShuffleIcon />
                </button>
                <button
                  className="icon-btn hero__icon-btn"
                  title={`Share the whole ${project.kind}`}
                  onClick={onShareAlbum}
                >
                  <ShareIcon />
                </button>
                {hasDownloadableVersions ? (
                  <button
                    className="icon-btn hero__icon-btn"
                    title={projectDownloadLabel ?? `Download the whole ${project.kind} for faster local playback`}
                    onClick={onDownloadProject}
                    disabled={!!projectDownloadLabel}
                  >
                    <DownloadIcon />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="simple-header">
            <div className="simple-header__title-row">
              <div className="simple-header__title">{project.name}</div>
              <button
                className="icon-btn simple-header__icon-btn"
                onClick={onEditProject}
                title="Edit project"
              >
                <EditIcon />
              </button>
              {hasDownloadableVersions ? (
                <button
                  className="icon-btn simple-header__icon-btn"
                  title={projectDownloadLabel ?? `Download the whole ${project.kind} for faster local playback`}
                  onClick={onDownloadProject}
                  disabled={!!projectDownloadLabel}
                >
                  <DownloadIcon />
                </button>
              ) : null}
            </div>
            <div className="simple-header__count">
              {tracks.length} track{tracks.length === 1 ? "" : "s"}
            </div>
          </div>
        )}

        <div className="tracklist">
          {tracks.length === 0 ? (
            <div className="tracklist__empty">No tracks in this project yet.</div>
          ) : (
            tracks.map((track, i) => {
              const version = defaultVersionFor(track, versionsByTrack);
              const isActive = nowPlaying?.trackId === track.id;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  version={version}
                  versions={versionsByTrack[track.id] ?? []}
                  onSwitchVersion={(versionId) => handleSwitchVersion(track, versionId)}
                  onAddCover={() => onAddTrackCover(track.id)}
                  onShare={version ? () => onShare(track, version) : undefined}
                  index={project.coverStyle === "album" ? i + 1 : undefined}
                  isFavorite={isFavorite(track.id, version?.id)}
                  onToggleFavorite={() => onToggleFavorite(track.id, version?.id)}
                  isActive={isActive}
                  isPlaying={isActive && status.isPlaying}
                  onActivate={() => activate(track)}
                  positionSeconds={isActive ? status.positionSeconds : 0}
                  durationSeconds={isActive ? status.durationSeconds : 0}
                  onSeek={seek}
                  playlists={playlists}
                  onAddToPlaylist={(playlistId) => onAddToPlaylist(playlistId, track.id, version?.id)}
                  onCreatePlaylistWithTrack={(name) =>
                    onCreatePlaylistWithTrack(name, track.id, version?.id)
                  }
                  onDownload={version ? () => onDownloadVersion(version.id) : undefined}
                  downloadBusy={!!version && downloadingVersionId === version.id}
                />
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
