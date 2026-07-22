import { useEffect, useMemo } from "react";
import { signInAnonymously } from "firebase/auth";
import { auth } from "./firebase";
import { SingleTrackView } from "./SingleTrackView";
import { AlbumView } from "./AlbumView";

/** Which kind of guest link the current path points at: a single-track link
 *  at `/s/{token}`, or a whole-project ("share this entire EP/album") link
 *  at `/a/{token}`. No router needed — this is the whole SPA's dispatch. */
function useRoute() {
  return useMemo(() => {
    const path = window.location.pathname;
    const albumMatch = path.match(/^\/a\/([A-Za-z0-9_-]+)/);
    if (albumMatch) return { kind: "album" as const, token: albumMatch[1] };
    const trackMatch = path.match(/^\/s\/([A-Za-z0-9_-]+)/);
    if (trackMatch) return { kind: "track" as const, token: trackMatch[1] };
    return { kind: "none" as const, token: null };
  }, []);
}

export default function App() {
  const route = useRoute();

  // Sign in anonymously so the live comments listener (used by both the
  // single-track and album views) passes the Firestore read rules.
  useEffect(() => {
    signInAnonymously(auth).catch(() => {
      /* comments stay empty; playback still works */
    });
  }, []);

  return (
    <div className="share-shell">
      <header className="share-header">
        <span className="share-brand">Session</span>
        <span className="share-mark">Peak-Sense</span>
      </header>
      <main className="share-main">
        {route.kind === "track" && route.token ? (
          <SingleTrackView token={route.token} />
        ) : route.kind === "album" && route.token ? (
          <AlbumView token={route.token} />
        ) : (
          <div className="share-error-card">
            <h1>This link isn't available.</h1>
            <p>This link is missing its token.</p>
          </div>
        )}
      </main>
    </div>
  );
}
