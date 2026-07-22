import { useEffect, useState } from "react";
import {
  getAlbumShareLinkPlaybackInfo,
  postAlbumShareLinkComment,
  type AlbumPlaybackInfo,
} from "./lib/api";
import { errorMessage, formatTime } from "./lib/format";
import { TrackPlayer } from "./TrackPlayer";

/** Guest view for a whole-project ("share this entire EP/album") link:
 *  `/a/{token}`. Shows a numbered tracklist; picking a track expands into
 *  the same player/comments experience as the single-track guest page. */
export function AlbumView({ token }: { token: string }) {
  const [info, setInfo] = useState<AlbumPlaybackInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    getAlbumShareLinkPlaybackInfo({ token })
      .then((result) => setInfo(result.data))
      .catch((err) => setLoadError(errorMessage(err)));
  }, [token]);

  if (loadError) {
    return (
      <div className="share-error-card">
        <h1>This link isn't available.</h1>
        <p>{loadError}</p>
      </div>
    );
  }

  if (!info) {
    return <div className="share-loading">Preparing the tracklist…</div>;
  }

  const selected = selectedIndex !== null ? info.tracks[selectedIndex] : null;

  if (selected) {
    return (
      <>
        <button
          type="button"
          className="share-back-link"
          onClick={() => setSelectedIndex(null)}
        >
          ← Back to {info.projectName}
        </button>
        <TrackPlayer
          key={selected.versionId}
          eyebrow={`Track ${selectedIndex! + 1} of ${info.tracks.length} — ${info.projectName}`}
          title={selected.trackTitle}
          versionLabel={selected.versionLabel}
          versionId={selected.versionId}
          streamUrl={selected.streamUrl}
          durationSeconds={selected.durationSeconds}
          peaks={selected.peaks}
          onPostComment={({ timestampSeconds, displayName, text }) =>
            postAlbumShareLinkComment({
              token,
              versionId: selected.versionId,
              timestampSeconds,
              displayName,
              text,
            }).then(() => {})
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="share-eyebrow">Private listening link</div>
      <h1 className="share-title">{info.projectName}</h1>
      <div className="share-version tabular">[{info.projectKind.toUpperCase()}]</div>

      <ol className="share-tracklist">
        {info.tracks.map((track, i) => (
          <li key={track.versionId} className="share-tracklist__item">
            <button
              type="button"
              className="share-tracklist__row"
              onClick={() => setSelectedIndex(i)}
            >
              <span className="share-tracklist__index tabular">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="share-tracklist__title">{track.trackTitle}</span>
              <span className="share-tracklist__version tabular">
                [{track.versionLabel.toUpperCase()}]
              </span>
              <span className="share-tracklist__duration tabular">
                {formatTime(track.durationSeconds)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
