import { useState } from "react";
import type { Track, Version } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { WaveformPlayer } from "./WaveformPlayer";
import { HeartIcon, PauseIcon, PlayIcon } from "./icons";
import { formatDuration } from "../lib/format";
import "./TrackRow.css";

interface TrackRowProps {
  track: Track;
  version: Version | undefined;
  /** All versions of this track (for the master-version switcher popover). */
  versions?: Version[];
  /** Called with the versionId the user picked from the version switcher. */
  onSwitchVersion?: (versionId: string) => void;
  /** Opens a native image picker and sets this track's own cover (individual mode only). */
  onAddCover?: () => void;
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
  versions = [],
  onSwitchVersion,
  onAddCover,
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
  const [showVersionMenu, setShowVersionMenu] = useState(false);
  const showNumber = index !== undefined;
  const isDefaultVersion = !!version && version.id === track.defaultVersionId;
  const hasMultipleVersions = versions.length > 1;

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
            <CoverThumb
              cover={track.coverImage}
              size={34}
              showAddAffordance={!track.coverImage?.path}
              onAdd={onAddCover}
            />
            {/* Skip the hover play/pause overlay over the bare "+" placeholder so the
                add-cover button underneath stays fully clickable — once a cover is set
                the overlay returns, matching every other row's hover-to-play behavior. */}
            {track.coverImage?.path ? (
              <span className="track-leading__overlay">
                {isActive && isPlaying ? <PauseIcon /> : <PlayIcon />}
              </span>
            ) : null}
          </div>
        )}

        <div className="track-row__main">
          <span className="track-row__title">{track.title}</span>
          {version?.bpm ? (
            <span className="track-row__tag tabular">{Math.round(version.bpm)} BPM</span>
          ) : null}
          {version?.key ? <span className="track-row__tag">{version.key}</span> : null}
          {version ? (
            <span className="version-chip-wrap">
              <span
                className={
                  "version-chip" +
                  (isDefaultVersion ? " is-default" : "") +
                  (hasMultipleVersions ? " is-switchable" : "")
                }
                role={hasMultipleVersions ? "button" : undefined}
                tabIndex={hasMultipleVersions ? 0 : undefined}
                onClick={(e) => {
                  if (!hasMultipleVersions) return;
                  e.stopPropagation();
                  setShowVersionMenu((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (!hasMultipleVersions) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowVersionMenu((v) => !v);
                  }
                }}
                title={hasMultipleVersions ? "Switch version" : undefined}
              >
                {version.label.toUpperCase()}
              </span>
              {showVersionMenu && hasMultipleVersions ? (
                <>
                  <div
                    className="version-menu-backdrop"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowVersionMenu(false);
                    }}
                  />
                  <div className="version-menu" onClick={(e) => e.stopPropagation()}>
                    {versions.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={
                          "version-menu__item" + (v.id === track.defaultVersionId ? " is-default" : "")
                        }
                        onClick={() => {
                          setShowVersionMenu(false);
                          onSwitchVersion?.(v.id);
                        }}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
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
            versionId={version.id}
            positionSeconds={positionSeconds}
            durationSeconds={durationSeconds || version.durationSeconds}
            onSeek={onSeek}
          />
        </div>
      ) : null}
    </div>
  );
}
