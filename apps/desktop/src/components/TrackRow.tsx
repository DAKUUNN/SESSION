import type { Track, Version } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { WaveformPlayer } from "./WaveformPlayer";
import { HeartIcon, PauseIcon, PlayIcon } from "./icons";
import { formatDuration } from "../lib/format";
import "./TrackRow.css";

interface TrackRowProps {
  track: Track;
  version: Version | undefined;
  /** Present in album mode (numbered tracklist); absent in individual mode. */
  index?: number;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  isActive: boolean;
  isPlaying: boolean;
  onActivate: () => void;
  positionSeconds: number;
  durationSeconds: number;
  onSeek: (seconds: number) => void;
}

export function TrackRow({
  track,
  version,
  index,
  isFavorite,
  onToggleFavorite,
  isActive,
  isPlaying,
  onActivate,
  positionSeconds,
  durationSeconds,
  onSeek,
}: TrackRowProps) {
  const showNumber = index !== undefined;
  const isDefaultVersion = !!version && version.id === track.defaultVersionId;

  return (
    <div>
      <div
        className={"track-row" + (isActive ? " is-active" : "")}
        role="button"
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
      >
        {showNumber ? (
          <div className={"track-leading track-leading--number" + (isActive ? " is-active" : "")}>
            <span className="track-num tabular">{index}</span>
            <span className="track-leading__overlay">
              {isActive && isPlaying ? <PauseIcon /> : <PlayIcon />}
            </span>
          </div>
        ) : (
          <div className={"track-leading track-leading--cover" + (isActive ? " is-active" : "")}>
            <CoverThumb cover={track.coverImage} size={34} />
            <span className="track-leading__overlay">
              {isActive && isPlaying ? <PauseIcon /> : <PlayIcon />}
            </span>
          </div>
        )}

        <div className="track-row__main">
          <span className="track-row__title">{track.title}</span>
          {version?.bpm ? (
            <span className="track-row__tag tabular">{Math.round(version.bpm)} BPM</span>
          ) : null}
          {version?.key ? <span className="track-row__tag">{version.key}</span> : null}
          {version ? (
            <span className={"version-chip" + (isDefaultVersion ? " is-default" : "")}>
              {version.label.toUpperCase()}
            </span>
          ) : null}
        </div>

        <span className="track-row__duration">
          {version ? formatDuration(version.durationSeconds) : "--:--"}
        </span>

        <button
          className={"favorite-btn" + (isFavorite ? " is-favorite" : "")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <HeartIcon filled={isFavorite} />
        </button>
      </div>

      {isActive && version ? (
        <div
          className="track-row-expanded"
          style={{ paddingLeft: showNumber ? 54 : 64 }}
        >
          <WaveformPlayer
            path={version.file.path}
            positionSeconds={positionSeconds}
            durationSeconds={durationSeconds || version.durationSeconds}
            onSeek={onSeek}
          />
        </div>
      ) : null}
    </div>
  );
}
