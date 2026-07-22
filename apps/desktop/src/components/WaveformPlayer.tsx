import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatDuration } from "../lib/format";
import "./WaveformPlayer.css";

const BUCKET_COUNT = 200;

// Module-level cache so re-mounting the same track (e.g. collapsing and
// re-expanding a row) doesn't re-request peak data from the backend.
const peaksCache = new Map<string, number[]>();
const peaksInflight = new Map<string, Promise<number[]>>();

function getPeaks(path: string): Promise<number[]> {
  const cached = peaksCache.get(path);
  if (cached) return Promise.resolve(cached);
  const inflight = peaksInflight.get(path);
  if (inflight) return inflight;
  const promise = api
    .generatePeaks(path, BUCKET_COUNT)
    .then((peaks) => {
      peaksCache.set(path, peaks);
      peaksInflight.delete(path);
      return peaks;
    })
    .catch((err) => {
      peaksInflight.delete(path);
      throw err;
    });
  peaksInflight.set(path, promise);
  return promise;
}

interface WaveformPlayerProps {
  path: string;
  /**
   * Not used yet — kept alongside `path` so that when per-version comments
   * land later, this component already has the version identity it'll need
   * to scope comments to (switching versions should only show that
   * version's comments).
   */
  versionId?: string;
  positionSeconds: number;
  durationSeconds: number;
  onSeek: (seconds: number) => void;
}

export function WaveformPlayer({
  path,
  positionSeconds,
  durationSeconds,
  onSeek,
}: WaveformPlayerProps) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setFailed(false);
    getPeaks(path)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const effectiveDuration = durationSeconds > 0 ? durationSeconds : 0;
  const playedRatio =
    effectiveDuration > 0 ? Math.min(1, positionSeconds / effectiveDuration) : 0;

  function handleSeek(clientX: number) {
    const el = bodyRef.current;
    if (!el || effectiveDuration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(ratio * effectiveDuration);
  }

  const bars: number[] = peaks ?? new Array(BUCKET_COUNT * 2).fill(0);
  const bucketCount = bars.length / 2;
  const playedBucket = Math.floor(playedRatio * bucketCount);

  return (
    <div className="waveform">
      <div className="waveform__pins" aria-hidden="true" />
      {peaks === null && !failed ? (
        <div className="waveform__loading">Analyzing waveform…</div>
      ) : (
        <div
          className="waveform__body"
          ref={bodyRef}
          onClick={(e) => handleSeek(e.clientX)}
        >
          {Array.from({ length: bucketCount }, (_, i) => {
            const min = bars[i * 2] ?? 0;
            const max = bars[i * 2 + 1] ?? 0;
            const magnitude = Math.max(Math.abs(min), Math.abs(max));
            const heightPct = Math.max(4, Math.min(100, magnitude * 100));
            return (
              <div
                key={i}
                className={"waveform__bar" + (i < playedBucket ? " is-played" : "")}
              >
                <span style={{ height: `${heightPct}%` }} />
              </div>
            );
          })}
        </div>
      )}
      <div className="waveform__meta">
        <span>{formatDuration(positionSeconds)}</span>
        <span>{formatDuration(effectiveDuration)}</span>
      </div>
    </div>
  );
}
