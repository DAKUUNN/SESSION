import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToComments, type Comment } from "./lib/comments";
import { errorMessage, formatTime } from "./lib/format";

interface TrackPlayerProps {
  /** Small uppercase label above the title — differs between the single-track
   *  page ("Private listening link") and the album page ("Track 2 of 8"). */
  eyebrow?: string;
  title: string;
  versionLabel: string;
  /** Comments are queried by this alone — same query regardless of whether a
   *  single-track or album link brought the guest here. */
  versionId: string;
  streamUrl: string;
  durationSeconds: number;
  peaks: number[];
  onPostComment: (input: {
    timestampSeconds: number;
    displayName: string;
    text: string;
  }) => Promise<void>;
}

/**
 * The waveform player + live timestamped comment thread for exactly one
 * track version. Shared by the single-track guest page and the album guest
 * page's per-track view (parameterized by `streamUrl`/`durationSeconds`/
 * `peaks` plus whichever function should actually post the comment) so both
 * pages render an identical listening experience.
 */
export function TrackPlayer({
  eyebrow,
  title,
  versionLabel,
  versionId,
  streamUrl,
  durationSeconds,
  peaks,
  onPostComment,
}: TrackPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);

  const [comments, setComments] = useState<Comment[]>([]);
  const [name, setName] = useState(() => localStorage.getItem("session-guest-name") ?? "");
  const [text, setText] = useState("");
  const [commentAt, setCommentAt] = useState<number | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Reset transient playback/comment-composer UI whenever the track changes
  // (the album view swaps props on the same mounted instance when the guest
  // picks a different track from the tracklist).
  useEffect(() => {
    setIsPlaying(false);
    setPosition(0);
    setText("");
    setCommentAt(null);
    setPostError(null);
  }, [versionId]);

  // Live comments for exactly this version (the whole point of scoping
  // comments per version: v1 feedback never bleeds into v2's view, and one
  // album track's thread never bleeds into another's).
  useEffect(() => {
    const unsubscribe = subscribeToComments(versionId, setComments, () => {
      /* rules rejected (anonymous auth disabled?) — leave comments empty */
    });
    return unsubscribe;
  }, [versionId]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  function seekFromClick(clientX: number) {
    const el = waveRef.current;
    const audio = audioRef.current;
    if (!el || !audio || durationSeconds <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * durationSeconds;
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    const at = commentAt ?? position;
    setPosting(true);
    setPostError(null);
    try {
      localStorage.setItem("session-guest-name", name);
      await onPostComment({
        timestampSeconds: at,
        displayName: name.trim() || "Guest",
        text: text.trim(),
      });
      setText("");
      setCommentAt(null);
    } catch (err) {
      setPostError(errorMessage(err));
    } finally {
      setPosting(false);
    }
  }

  const bucketCount = Math.floor(peaks.length / 2);
  const playedBucket =
    durationSeconds > 0 ? Math.floor((position / durationSeconds) * bucketCount) : 0;

  return (
    <>
      {eyebrow ? <div className="share-eyebrow">{eyebrow}</div> : null}
      <h1 className="share-title">{title}</h1>
      <div className="share-version tabular">[{versionLabel.toUpperCase()}]</div>

      <audio
        ref={audioRef}
        src={streamUrl}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
      />

      <div className="share-player">
        <button className="share-play" onClick={togglePlay} title={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="share-wave-wrap">
          <div className="share-wave" ref={waveRef} onClick={(e) => seekFromClick(e.clientX)}>
            {Array.from({ length: bucketCount }, (_, i) => {
              const min = peaks[i * 2] ?? 0;
              const max = peaks[i * 2 + 1] ?? 0;
              const magnitude = Math.max(Math.abs(min), Math.abs(max));
              return (
                <div
                  key={i}
                  className={"share-wave__bar" + (i < playedBucket ? " is-played" : "")}
                >
                  <span style={{ height: `${Math.max(4, Math.min(100, magnitude * 100))}%` }} />
                </div>
              );
            })}
            {durationSeconds > 0
              ? comments.map((c) => (
                  <button
                    key={c.id}
                    className="share-pin"
                    style={{ left: `${(c.timestampInTrackSeconds / durationSeconds) * 100}%` }}
                    title={`${formatTime(c.timestampInTrackSeconds)} — ${c.authorDisplayName}: ${c.text}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const audio = audioRef.current;
                      if (audio) audio.currentTime = c.timestampInTrackSeconds;
                    }}
                  />
                ))
              : null}
          </div>
          <div className="share-times tabular">
            <span>{formatTime(position)}</span>
            <span>{formatTime(durationSeconds)}</span>
          </div>
        </div>
      </div>

      <section className="share-comments">
        <div className="share-comments__head mono-label">Comments — {versionLabel}</div>

        {comments.length === 0 ? (
          <div className="share-comments__empty">
            No comments on this version yet. Click play, then leave the first one.
          </div>
        ) : (
          <ul className="share-comments__list">
            {comments.map((c) => (
              <li key={c.id} className="share-comment">
                <button
                  className="share-comment__time tabular"
                  onClick={() => {
                    const audio = audioRef.current;
                    if (audio) audio.currentTime = c.timestampInTrackSeconds;
                  }}
                >
                  {formatTime(c.timestampInTrackSeconds)}
                </button>
                <span
                  className={
                    "share-comment__author" + (c.authorType === "owner" ? " is-owner" : "")
                  }
                >
                  {c.authorDisplayName}
                </span>
                <span className="share-comment__text">{c.text}</span>
              </li>
            ))}
          </ul>
        )}

        <form className="share-comment-form" onSubmit={submitComment}>
          <div className="share-comment-form__row">
            <input
              className="share-input share-input--name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <button
              type="button"
              className="share-at tabular"
              onClick={() => setCommentAt(position)}
              title="Pin the comment to the current playback position"
            >
              @ {formatTime(commentAt ?? position)}
            </button>
          </div>
          <div className="share-comment-form__row">
            <input
              className="share-input"
              placeholder="Leave feedback at this point in the track…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={1000}
            />
            <button type="submit" className="share-submit" disabled={posting || !text.trim()}>
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
          {postError ? <div className="share-error">{postError}</div> : null}
        </form>
      </section>
    </>
  );
}
