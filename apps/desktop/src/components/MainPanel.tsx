import { useCallback, useMemo } from "react";
import type { CoverStyle, Project, Track, Version } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { TrackRow } from "./TrackRow";
import { EditIcon, PauseIcon, PlayIcon, ShareIcon, ShuffleIcon } from "./icons";
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
  onChangeCoverStyle: (style: CoverStyle) => void;
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
}

export function MainPanel({
  project,
  tracks,
  versionsByTrack,
  onChangeCoverStyle,
  isFavorite,
  onToggleFavorite,
  player,
  onSwitchDefaultVersion,
  onImportPaths,
  onEditProject,
  onAddProjectCover,
  onAddTrackCover,
  onShare,
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
      <div className="main-panel__toolbar">
        <div className="segmented">
          <button
            className={"segmented__btn" + (project.coverStyle === "album" ? " is-selected" : "")}
            onClick={() => onChangeCoverStyle("album")}
          >
            Album cover
          </button>
          <button
            className={
              "segmented__btn" + (project.coverStyle === "individual" ? " is-selected" : "")
            }
            onClick={() => onChangeCoverStyle("individual")}
          >
            Individual covers
          </button>
        </div>
      </div>

      <div className="main-panel__scroll">
        {project.coverStyle === "album" ? (
          <div className="hero">
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
                  title="Share link"
                  onClick={() => {
                    // Hero-level share targets the currently playing track if
                    // it belongs to this project, else the first track.
                    const current = tracks.find((t) => t.id === nowPlaying?.trackId) ?? tracks[0];
                    if (!current) return;
                    const version = defaultVersionFor(current, versionsByTrack);
                    if (version) onShare(current, version);
                  }}
                >
                  <ShareIcon />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="simple-header">
            <div className="simple-header__title-row">
              <div className="simple-header__title">{project.name}</div>
              <button
                className="icon-btn simple-header__edit-btn"
                onClick={onEditProject}
                title="Edit project"
              >
                <EditIcon />
              </button>
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
                />
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
