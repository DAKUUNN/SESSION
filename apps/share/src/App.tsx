import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signInAnonymously } from "firebase/auth";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "./firebase";

interface PlaybackInfo {
  streamUrl: string;
  trackTitle: string;
  versionId: string;
  versionLabel: string;
  durationSeconds: number;
  peaks: number[];
}

interface Comment {
  id: string;
  timestampInTrackSeconds: number;
  authorType: "guest" | "owner";
  authorDisplayName: string;
  text: string;
  createdAt: Timestamp | null;
}

const getPlaybackInfo = httpsCallable<{ token: string }, PlaybackInfo>(
  functions,
  "getShareLinkPlaybackInfo",
);
const postComment = httpsCallable<
  { token: string; timestampSeconds: number; displayName: string; text: string },
  { ok: boolean }
>(functions, "postShareLinkComment");

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Something went wrong.";
}

export default function App() {
  // The share token is the whole path: /s/{token}
  const token = useMemo(() => {
    const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  }, []);

  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // Load playback info once; sign in anonymously so the live comments
  // listener passes the Firestore read rules.
  useEffect(() => {
    if (!token) {
      setLoadError("This link is missing its token.");
      return;
    }
    signInAnonymously(auth).catch(() => {
      /* comments stay empty; playback still works */
    });
    getPlaybackInfo({ token })
      .then((result) => setInfo(result.data))
      .catch((err) => setLoadError(errorMessage(err)));
  }, [token]);

  // Live comments for exactly this version (the whole point of scoping
  // comments per version: v1 feedback never bleeds into v2's view).
  useEffect(() => {
    if (!info) return;
    const q = query(
      collection(db, "comments"),
      where("versionId", "==", info.versionId),
      orderBy("createdAt", "asc"),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setComments(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              timestampInTrackSeconds: Number(data.timestampInTrackSeconds ?? 0),
              authorType: data.authorType === "owner" ? "owner" : "guest",
              authorDisplayName: String(data.authorDisplayName ?? "Guest"),
              text: String(data.text ?? ""),
              createdAt: (data.createdAt as Timestamp | undefined) ?? null,
            };
          }),
        );
      },
      () => {
        /* rules rejected (anonymous auth disabled?) — leave comments empty */
      },
    );
    return unsubscribe;
  }, [info]);

  const duration = info?.durationSeconds ?? 0;

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  function seekFromClick(clientX: number) {
    const el = waveRef.current;
    const audio = audioRef.current;
    if (!el || !audio || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !info) return;
    const at = commentAt ?? position;
    setPosting(true);
    setPostError(null);
    try {
      localStorage.setItem("session-guest-name", name);
      await postComment({
        token,
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

  if (loadError) {
    return (
      <div className="share-shell">
        <header className="share-header">
          <span className="share-brand">Session</span>
          <span className="share-mark">Peak-Sense</span>
        </header>
        <main className="share-main">
          <div className="share-error-card">
            <h1>This link isn't available.</h1>
            <p>{loadError}</p>
          </div>
        </main>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="share-shell">
        <header className="share-header">
          <span className="share-brand">Session</span>
          <span className="share-mark">Peak-Sense</span>
        </header>
        <main className="share-main">
          <div className="share-loading">Preparing the track…</div>
        </main>
      </div>
    );
  }

  const bucketCount = Math.floor(info.peaks.length / 2);
  const playedBucket = duration > 0 ? Math.floor((position / duration) * bucketCount) : 0;

  return (
    <div className="share-shell">
      <header className="share-header">
        <span className="share-brand">Session</span>
        <span className="share-mark">Peak-Sense</span>
      </header>

      <main className="share-main">
        <div className="share-eyebrow">Private listening link</div>
        <h1 className="share-title">{info.trackTitle}</h1>
        <div className="share-version tabular">[{info.versionLabel.toUpperCase()}]</div>

        <audio
          ref={audioRef}
          src={info.streamUrl}
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
            <div
              className="share-wave"
              ref={waveRef}
              onClick={(e) => seekFromClick(e.clientX)}
            >
              {Array.from({ length: bucketCount }, (_, i) => {
                const min = info.peaks[i * 2] ?? 0;
                const max = info.peaks[i * 2 + 1] ?? 0;
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
              {duration > 0
                ? comments.map((c) => (
                    <button
                      key={c.id}
                      className="share-pin"
                      style={{ left: `${(c.timestampInTrackSeconds / duration) * 100}%` }}
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
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>

        <section className="share-comments">
          <div className="share-comments__head mono-label">
            Comments — {info.versionLabel}
          </div>

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
                      "share-comment__author" +
                      (c.authorType === "owner" ? " is-owner" : "")
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
              <button
                type="submit"
                className="share-submit"
                disabled={posting || !text.trim()}
              >
                {posting ? "Posting…" : "Post"}
              </button>
            </div>
            {postError ? <div className="share-error">{postError}</div> : null}
          </form>
        </section>
      </main>
    </div>
  );
}
