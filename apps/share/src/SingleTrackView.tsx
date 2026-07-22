import { useEffect, useState } from "react";
import { getShareLinkPlaybackInfo, postShareLinkComment, type TrackPlaybackInfo } from "./lib/api";
import { errorMessage } from "./lib/format";
import { TrackPlayer } from "./TrackPlayer";

/** Guest view for a single-track link: `/s/{token}`. */
export function SingleTrackView({ token }: { token: string }) {
  const [info, setInfo] = useState<TrackPlaybackInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getShareLinkPlaybackInfo({ token })
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
    return <div className="share-loading">Preparing the track…</div>;
  }

  return (
    <TrackPlayer
      eyebrow="Private listening link"
      title={info.trackTitle}
      versionLabel={info.versionLabel}
      versionId={info.versionId}
      streamUrl={info.streamUrl}
      durationSeconds={info.durationSeconds}
      peaks={info.peaks}
      onPostComment={({ timestampSeconds, displayName, text }) =>
        postShareLinkComment({ token, timestampSeconds, displayName, text }).then(() => {})
      }
    />
  );
}
