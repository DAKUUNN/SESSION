/** Typed wrappers around the guest-facing Cloud Functions. */
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

export interface TrackPlaybackInfo {
  streamUrl: string;
  trackTitle: string;
  versionId: string;
  versionLabel: string;
  durationSeconds: number;
  peaks: number[];
}

export interface AlbumTrackPlaybackInfo {
  trackTitle: string;
  versionId: string;
  versionLabel: string;
  durationSeconds: number;
  peaks: number[];
  streamUrl: string;
}

export interface AlbumPlaybackInfo {
  projectName: string;
  projectKind: string;
  tracks: AlbumTrackPlaybackInfo[];
}

export const getShareLinkPlaybackInfo = httpsCallable<{ token: string }, TrackPlaybackInfo>(
  functions,
  "getShareLinkPlaybackInfo",
);

export const postShareLinkComment = httpsCallable<
  { token: string; timestampSeconds: number; displayName: string; text: string },
  { ok: boolean }
>(functions, "postShareLinkComment");

export const getAlbumShareLinkPlaybackInfo = httpsCallable<
  { token: string },
  AlbumPlaybackInfo
>(functions, "getAlbumShareLinkPlaybackInfo");

export const postAlbumShareLinkComment = httpsCallable<
  {
    token: string;
    versionId: string;
    timestampSeconds: number;
    displayName: string;
    text: string;
  },
  { ok: boolean }
>(functions, "postAlbumShareLinkComment");
