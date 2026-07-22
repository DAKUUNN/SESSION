import { useCallback, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FileRef } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { PauseIcon, PlayIcon, VolumeIcon, VolumeMuteIcon } from "./icons";
import { formatDuration } from "../lib/format";
import type { NowPlaying } from "../hooks/usePlayer";
import type { PlaybackStatus } from "../lib/api";
import "./PlayerBar.css";

/** A click/drag-to-set horizontal bar; reused for the scrubber and the volume control. */
function DragBar({
  ratio,
  onChange,
  trackClassName,
  fillClassName,
  containerClassName,
}: {
  ratio: number;
  onChange: (ratio: number) => void;
  trackClassName: string;
  fillClassName: string;
  containerClassName: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const ratioFromEvent = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(ratioFromEvent(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(ratioFromEvent(e.clientX));
  };

  return (
    <div
      className={containerClassName}
      ref={ref}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      <div className={trackClassName}>
        <div className={fillClassName} style={{ width: `${ratio * 100}%` }} />
        <div className="drag-bar__thumb" style={{ left: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

interface PlayerBarProps {
  nowPlaying: NowPlaying | null;
  status: PlaybackStatus;
  cover?: FileRef | null;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  volume: number;
  onVolumeChange: (v: number) => void;
}

export function PlayerBar({
  nowPlaying,
  status,
  cover,
  onTogglePlay,
  onSeek,
  volume,
  onVolumeChange,
}: PlayerBarProps) {
  const duration = status.durationSeconds;
  const positionRatio = duration > 0 ? Math.min(1, status.positionSeconds / duration) : 0;

  // Remembers the volume from just before a mute-click, so clicking the
  // speaker icon again restores it instead of just jumping back to 100%.
  const lastVolumeRef = useRef(volume || 0.8);
  if (volume > 0) lastVolumeRef.current = volume;

  function handleToggleMute() {
    onVolumeChange(volume > 0 ? 0 : lastVolumeRef.current);
  }

  return (
    <footer className="player-bar">
      {cover?.path ? (
        <div
          className="player-bar__glow ambient-glow"
          style={{ backgroundImage: `url(${convertFileSrc(cover.path)})` }}
        />
      ) : null}
      <div className="player-bar__transport">
        <button
          className="player-bar__play"
          onClick={onTogglePlay}
          disabled={!nowPlaying}
          title={status.isPlaying ? "Pause" : "Play"}
        >
          {status.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
      </div>

      {nowPlaying ? (
        <>
          <div className="player-bar__meta">
            <CoverThumb cover={cover} size={40} />
            <div className="player-bar__titles">
              <div className="player-bar__title">{nowPlaying.title}</div>
              <div className="player-bar__version">{nowPlaying.versionLabel}</div>
            </div>
          </div>

          <div className="player-bar__scrubber-zone">
            <span className="player-bar__time tabular">
              {formatDuration(status.positionSeconds)}
            </span>
            <DragBar
              ratio={positionRatio}
              onChange={(r) => onSeek(r * duration)}
              containerClassName="scrubber"
              trackClassName="scrubber__track"
              fillClassName="scrubber__fill"
            />
            <span className="player-bar__time player-bar__time--end tabular">
              {formatDuration(duration)}
            </span>
          </div>
        </>
      ) : (
        <div className="player-bar__scrubber-zone">
          <span className="player-bar__empty">Nothing playing</span>
        </div>
      )}

      <div className="player-bar__volume">
        <button
          type="button"
          className="player-bar__volume-icon"
          onClick={handleToggleMute}
          title={volume <= 0 ? "Unmute" : "Mute"}
        >
          {volume <= 0 ? <VolumeMuteIcon /> : <VolumeIcon />}
        </button>
        <DragBar
          ratio={volume}
          onChange={onVolumeChange}
          containerClassName="volume-track"
          trackClassName="volume-track__base"
          fillClassName="volume-track__fill"
        />
      </div>
    </footer>
  );
}
