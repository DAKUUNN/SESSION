import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { api } from "../lib/api";
import { auth } from "../lib/firebase";
import {
  addOwnerComment,
  subscribeToComments,
  type VersionComment,
} from "../lib/sharing";
import { formatDuration } from "../lib/format";
import "./WaveformPlayer.css";

const MIN_BUCKETS = 80;
const MAX_BUCKETS = 480;
/** Snap grid for the resize-observer-driven bucket count — coarse enough that
 *  dragging the window doesn't spam the (uncached, full-decode) Rust peak
 *  generator, fine enough that the bar width stays visually consistent
 *  across window sizes instead of turning chunky/blocky at fullscreen. */
const BUCKET_SNAP = 20;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** ~4px per bar is the density that reads as a "real" waveform rather than
 *  either a pixelated block (too few buckets for a wide container) or a
 *  smeared blur (too many for a narrow one). */
function bucketCountForWidth(width: number): number {
  return Math.round(clamp(width / 4, MIN_BUCKETS, MAX_BUCKETS) / BUCKET_SNAP) * BUCKET_SNAP;
}

// Module-level cache so re-mounting the same track at the same bucket count
// (e.g. collapsing and re-expanding a row without resizing) doesn't
// re-request peak data from the backend.
const peaksCache = new Map<string, number[]>();
const peaksInflight = new Map<string, Promise<number[]>>();

function getPeaks(path: string, bucketCount: number): Promise<number[]> {
  const key = `${path}::${bucketCount}`;
  const cached = peaksCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = peaksInflight.get(key);
  if (inflight) return inflight;
  const promise = api
    .generatePeaks(path, bucketCount)
    .then((peaks) => {
      peaksCache.set(key, peaks);
      peaksInflight.delete(key);
      return peaks;
    })
    .catch((err) => {
      peaksInflight.delete(key);
      throw err;
    });
  peaksInflight.set(key, promise);
  return promise;
}

interface WaveformPlayerProps {
  path: string;
  /**
   * Scopes the comment thread: every comment is pinned to exactly one
   * version, so switching a track's master version switches which thread
   * is shown (v1 feedback never appears while v2 is selected).
   */
  versionId?: string;
  positionSeconds: number;
  durationSeconds: number;
  onSeek: (seconds: number) => void;
}

export function WaveformPlayer({
  path,
  versionId,
  positionSeconds,
  durationSeconds,
  onSeek,
}: WaveformPlayerProps) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [bucketCount, setBucketCount] = useState(200);
  const bodyRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-derives the bucket count from the rendered width so the waveform
  // stays crisp instead of turning into a handful of fat blocks when the
  // window (and this row with it) goes fullscreen. Debounced so dragging a
  // window edge doesn't spam the backend's full-file peak decode.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const desired = bucketCountForWidth(width);
        setBucketCount((prev) => (Math.abs(prev - desired) >= BUCKET_SNAP ? desired : prev));
      }, 200);
    });
    observer.observe(el);
    return () => {
      if (timeout) clearTimeout(timeout);
      observer.disconnect();
    };
  }, []);

  const [user, setUser] = useState<User | null>(null);
  const [comments, setComments] = useState<VersionComment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentAt, setCommentAt] = useState<number | null>(null);
  const [posting, setPosting] = useState(false);
  const [showComments, setShowComments] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setFailed(false);
    getPeaks(path, bucketCount)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, bucketCount]);

  // Live comment feed for this version — only when signed in (Firestore
  // rules require an authenticated reader). Signed-out artists simply see
  // no comments, never an error.
  useEffect(() => {
    setComments([]);
    if (!versionId || !user) return;
    return subscribeToComments(versionId, setComments, () => setComments([]));
  }, [versionId, user]);

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

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!versionId || !user || !commentText.trim()) return;
    setPosting(true);
    try {
      await addOwnerComment({
        versionId,
        ownerUid: user.uid,
        authorDisplayName: user.email?.split("@")[0] ?? "Artist",
        timestampInTrackSeconds: commentAt ?? positionSeconds,
        text: commentText.trim(),
      });
      setCommentText("");
      setCommentAt(null);
    } catch {
      /* rules rejected or offline — keep the text so nothing is lost */
    } finally {
      setPosting(false);
    }
  }

  const bars: number[] = peaks ?? new Array(bucketCount * 2).fill(0);
  const playedBucket = Math.floor(playedRatio * bucketCount);

  return (
    <div className="waveform" ref={wrapRef}>
      <div className="waveform__pins" aria-hidden={comments.length === 0}>
        {effectiveDuration > 0
          ? comments.map((c) => (
              <button
                key={c.id}
                type="button"
                className="waveform__pin"
                style={{
                  left: `${Math.min(100, (c.timestampInTrackSeconds / effectiveDuration) * 100)}%`,
                }}
                title={`${formatDuration(c.timestampInTrackSeconds)} — ${c.authorDisplayName}: ${c.text}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(c.timestampInTrackSeconds);
                }}
              />
            ))
          : null}
      </div>
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
                className={
                  "waveform__bar" +
                  (i < playedBucket ? " is-played" : "") +
                  (i === playedBucket ? " is-current" : "")
                }
              >
                <span style={{ height: `${heightPct}%` }} />
              </div>
            );
          })}
        </div>
      )}
      <div className="waveform__meta">
        <span>{formatDuration(positionSeconds)}</span>
        {versionId && user ? (
          <button
            type="button"
            className="waveform__comments-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setShowComments((v) => !v);
            }}
          >
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </button>
        ) : null}
        <span>{formatDuration(effectiveDuration)}</span>
      </div>

      {showComments && versionId && user ? (
        <div className="waveform__comments" onClick={(e) => e.stopPropagation()}>
          {comments.length > 0 ? (
            <ul className="waveform__comment-list">
              {comments.map((c) => (
                <li key={c.id} className="waveform__comment">
                  <button
                    type="button"
                    className="waveform__comment-time"
                    onClick={() => onSeek(c.timestampInTrackSeconds)}
                  >
                    {formatDuration(c.timestampInTrackSeconds)}
                  </button>
                  <span
                    className={
                      "waveform__comment-author" + (c.authorType === "owner" ? " is-owner" : "")
                    }
                  >
                    {c.authorDisplayName}
                  </span>
                  <span className="waveform__comment-text">{c.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="waveform__comments-empty">No comments on this version yet.</div>
          )}
          <form className="waveform__comment-form" onSubmit={submitComment}>
            <button
              type="button"
              className="waveform__comment-at"
              onClick={() => setCommentAt(positionSeconds)}
              title="Pin to the current playback position"
            >
              @ {formatDuration(commentAt ?? positionSeconds)}
            </button>
            <input
              className="waveform__comment-input"
              placeholder="Add a note at this point…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              maxLength={1000}
            />
            <button
              type="submit"
              className="waveform__comment-post"
              disabled={posting || !commentText.trim()}
            >
              {posting ? "…" : "Post"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
