import { useMemo } from "react";
import type { CoverStyle, Project, Track, Version } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { TrackRow } from "./TrackRow";
import { PauseIcon, PlayIcon, ShareIcon, ShuffleIcon } from "./icons";
import { formatDuration, formatRelativeTime } from "../lib/format";
import type { PlayerApi } from "../hooks/usePlayer";
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
}

export function MainPanel({
  project,
  tracks,
  versionsByTrack,
  onChangeCoverStyle,
  isFavorite,
  onToggleFavorite,
  player,
}: MainPanelProps) {
  const { nowPlaying, status, loadAndPlay, seek } = player;

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

  return (
    <section className="main-panel">
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
              <CoverThumb cover={project.coverImage} size={148} showAddAffordance />
            </div>
            <div className="hero__info">
              <div className="hero__eyebrow">{project.kind}</div>
              <h1 className="hero__title">{project.name}</h1>
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
                <button className="icon-btn hero__icon-btn" title="Share link">
                  <ShareIcon />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="simple-header">
            <div className="simple-header__title">{project.name}</div>
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
