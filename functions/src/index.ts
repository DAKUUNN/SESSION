/**
 * Session Cloud Functions — the only server-side code in the project.
 *
 * Responsibilities (and nothing more):
 *  - hold an artist's Dropbox refresh token so guest share pages can stream
 *    audio without the artist's device being online (`dropboxTokens/{uid}`,
 *    locked to `allow read, write: if false` in firestore.rules — Admin SDK
 *    here is the only way in or out)
 *  - mint/revoke share-link tokens and validate them on every guest request
 *  - write guest comments only after re-validating the share token
 *
 * The Dropbox App Key is a public client id (PKCE app, no secret anywhere).
 */
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { randomBytes } from "node:crypto";

initializeApp();
const db = getFirestore();

const DROPBOX_APP_KEY = "0p4wy3rkh5d9yi6";
const REGION = "europe-west3";

interface ShareLinkDoc {
  ownerUid: string;
  trackTitle: string;
  versionId: string;
  versionLabel: string;
  dropboxPath: string;
  durationSeconds: number;
  /** Flattened min/max peak pairs for waveform rendering on the guest page. */
  peaks: number[];
  revoked: boolean;
  viewCount: number;
  createdAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
}

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError("unauthenticated", "sign in first");
  return uid;
}

function requireString(value: unknown, name: string, maxLen = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    throw new HttpsError("invalid-argument", `missing or invalid ${name}`);
  }
  return value;
}

/** Exchanges the stored refresh token for a short-lived Dropbox access token. */
async function dropboxAccessTokenFor(ownerUid: string): Promise<string> {
  const snap = await db.doc(`dropboxTokens/${ownerUid}`).get();
  const refreshToken = snap.get("refreshToken") as string | undefined;
  if (!refreshToken) {
    throw new HttpsError(
      "failed-precondition",
      "the owner's Dropbox connection is not registered for sharing",
    );
  }
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: DROPBOX_APP_KEY,
    }),
  });
  if (!resp.ok) {
    throw new HttpsError("internal", `Dropbox token refresh failed (${resp.status})`);
  }
  const body = (await resp.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new HttpsError("internal", "Dropbox token refresh returned no access token");
  }
  return body.access_token;
}

/** Desktop app registers (or re-registers) the artist's Dropbox refresh token. */
export const storeDropboxToken = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const refreshToken = requireString(request.data?.refreshToken, "refreshToken");
  await db.doc(`dropboxTokens/${uid}`).set({
    refreshToken,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** Mints an unguessable share token for one specific track version. */
export const createShareLink = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const data = request.data ?? {};
  const doc: ShareLinkDoc = {
    ownerUid: uid,
    trackTitle: requireString(data.trackTitle, "trackTitle", 300),
    versionId: requireString(data.versionId, "versionId", 100),
    versionLabel: requireString(data.versionLabel, "versionLabel", 100),
    dropboxPath: requireString(data.dropboxPath, "dropboxPath"),
    durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : 0,
    peaks: Array.isArray(data.peaks) ? data.peaks.slice(0, 4000).map(Number) : [],
    revoked: false,
    viewCount: 0,
    createdAt: FieldValue.serverTimestamp(),
  };
  // 24 random bytes -> 32-char base64url token; the token IS the access
  // control, so it must be unguessable and minted server-side.
  const token = randomBytes(24).toString("base64url");
  await db.doc(`shareLinks/${token}`).set(doc);
  return { token };
});

/** Owner revokes a link; guests hitting it afterwards get denied. */
export const revokeShareLink = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const token = requireString(request.data?.token, "token", 100);
  const ref = db.doc(`shareLinks/${token}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get("ownerUid") !== uid) {
    throw new HttpsError("permission-denied", "not your link");
  }
  await ref.update({ revoked: true });
  return { ok: true };
});

/**
 * Guest entry point: validates the token (existence + revocation re-checked
 * on EVERY call) and returns playback metadata plus a short-lived Dropbox
 * streaming URL. No Firebase auth required — the token is the credential.
 */
export const getShareLinkPlaybackInfo = onCall({ region: REGION }, async (request) => {
  const token = requireString(request.data?.token, "token", 100);
  const snap = await db.doc(`shareLinks/${token}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "this link does not exist");
  const link = snap.data() as ShareLinkDoc;
  if (link.revoked) throw new HttpsError("permission-denied", "this link has been revoked");

  const accessToken = await dropboxAccessTokenFor(link.ownerUid);
  const resp = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: link.dropboxPath }),
  });
  if (!resp.ok) {
    throw new HttpsError("internal", `could not prepare the audio stream (${resp.status})`);
  }
  const body = (await resp.json()) as { link?: string };
  if (!body.link) throw new HttpsError("internal", "Dropbox returned no streaming link");

  await snap.ref.update({ viewCount: FieldValue.increment(1) });

  return {
    streamUrl: body.link,
    trackTitle: link.trackTitle,
    versionId: link.versionId,
    versionLabel: link.versionLabel,
    durationSeconds: link.durationSeconds,
    peaks: link.peaks,
  };
});

/** Guest comment write — only path for guests, re-validates the token. */
export const postShareLinkComment = onCall({ region: REGION }, async (request) => {
  const token = requireString(request.data?.token, "token", 100);
  const displayName = requireString(request.data?.displayName, "displayName", 80);
  const text = requireString(request.data?.text, "text", 1000);
  const timestamp = Number(request.data?.timestampSeconds);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new HttpsError("invalid-argument", "invalid timestamp");
  }

  const snap = await db.doc(`shareLinks/${token}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "this link does not exist");
  const link = snap.data() as ShareLinkDoc;
  if (link.revoked) throw new HttpsError("permission-denied", "this link has been revoked");

  await db.collection("comments").add({
    versionId: link.versionId,
    ownerUid: link.ownerUid,
    shareToken: token,
    timestampInTrackSeconds: timestamp,
    authorType: "guest",
    authorDisplayName: displayName,
    text,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});
