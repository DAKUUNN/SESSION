import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FileRef } from "@session/shared-types";
import { api, type PlaybackStatus } from "../lib/api";

const IDLE_STATUS: PlaybackStatus = {
  positionSeconds: 0,
  durationSeconds: 0,
  isPlaying: false,
};

export interface NowPlaying {
  trackId: string;
  versionId: string;
  title: string;
  versionLabel: string;
  /** Captured at load time so the player bar can show art without a cross-project lookup. */
  cover?: FileRef | null;
}

/**
 * Owns the single "now playing" slot for the whole app: which track/version
 * is loaded in the backend audio engine, and the live transport status.
 * Status is pushed by the backend on `playback://status`; we also poll once
 * on mount in case the emitter hasn't fired yet.
 */
export function usePlayer() {
  const [status, setStatus] = useState<PlaybackStatus>(IDLE_STATUS);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [volume, setVolumeState] = useState(0.8);
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<PlaybackStatus>("playback://status", (event) => {
      if (!cancelled) setStatus(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* backend event not available yet — non-fatal */
      });

    api
      .audioGetStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* backend command not wired yet — keep idle status */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const loadAndPlay = useCallback(
    async (info: NowPlaying, path: string) => {
      const current = nowPlayingRef.current;
      if (
        current &&
        current.trackId === info.trackId &&
        current.versionId === info.versionId
      ) {
        if (status.isPlaying) {
          await api.audioPause().catch(() => {});
        } else {
          await api.audioPlay().catch(() => {});
        }
        return;
      }
      setNowPlaying(info);
      setStatus({ positionSeconds: 0, durationSeconds: 0, isPlaying: false });
      try {
        await api.audioLoad(path);
        await api.audioPlay();
      } catch {
        /* backend not ready — UI still reflects the selection */
      }
    },
    [status.isPlaying],
  );

  /**
   * Switches the master/default version of the track that's currently
   * loaded, continuing playback from `resumeSeconds` instead of restarting
   * from zero (unlike `loadAndPlay`, which always resets position). If the
   * track was playing, playback resumes after the load; if it was paused,
   * it stays paused at that position on the new version.
   */
  const switchVersion = useCallback(
    async (info: NowPlaying, path: string, resumeSeconds: number, resumePlaying: boolean) => {
      setNowPlaying(info);
      setStatus((prev) => ({
        ...prev,
        positionSeconds: resumeSeconds,
        isPlaying: resumePlaying,
      }));
      try {
        await api.audioLoad(path);
        await api.audioSeek(resumeSeconds);
        if (resumePlaying) {
          await api.audioPlay();
        }
      } catch {
        /* backend not ready — UI still reflects the selection */
      }
    },
    [],
  );

  const togglePlay = useCallback(async () => {
    if (!nowPlayingRef.current) return;
    try {
      if (status.isPlaying) await api.audioPause();
      else await api.audioPlay();
    } catch {
      /* ignore */
    }
  }, [status.isPlaying]);

  const seek = useCallback((seconds: number) => {
    setStatus((prev) => ({ ...prev, positionSeconds: seconds }));
    api.audioSeek(seconds).catch(() => {});
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    api.audioSetVolume(v).catch(() => {});
  }, []);

  return { status, nowPlaying, volume, loadAndPlay, switchVersion, togglePlay, seek, setVolume };
}

export type PlayerApi = ReturnType<typeof usePlayer>;
