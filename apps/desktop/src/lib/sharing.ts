/**
 * Share links + timestamped comments — the Firestore/Cloud-Functions side.
 *
 * Comments are ALWAYS scoped to one specific versionId: the subscription
 * below filters on it, so switching a track's master version switches which
 * comment thread is visible (v1 feedback never bleeds into v2's view).
 */
import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions, SHARE_BASE_URL } from "./firebase";

export interface VersionComment {
  id: string;
  versionId: string;
  timestampInTrackSeconds: number;
  authorType: "guest" | "owner";
  authorDisplayName: string;
  text: string;
  createdAt: Timestamp | null;
}

export interface ShareLinkSummary {
  token: string;
  url: string;
  versionLabel: string;
  revoked: boolean;
  viewCount: number;
}

const createShareLinkFn = httpsCallable<
  {
    trackTitle: string;
    versionId: string;
    versionLabel: string;
    dropboxPath: string;
    durationSeconds: number;
    peaks: number[];
  },
  { token: string }
>(functions, "createShareLink");

const revokeShareLinkFn = httpsCallable<{ token: string }, { ok: boolean }>(
  functions,
  "revokeShareLink",
);

const storeDropboxTokenFn = httpsCallable<{ refreshToken: string }, { ok: boolean }>(
  functions,
  "storeDropboxToken",
);

export function shareUrlFor(token: string): string {
  return `${SHARE_BASE_URL}/s/${token}`;
}

export async function storeDropboxToken(refreshToken: string): Promise<void> {
  await storeDropboxTokenFn({ refreshToken });
}

export async function createShareLink(input: {
  trackTitle: string;
  versionId: string;
  versionLabel: string;
  dropboxPath: string;
  durationSeconds: number;
  peaks: number[];
}): Promise<string> {
  const result = await createShareLinkFn(input);
  return result.data.token;
}

export async function revokeShareLink(token: string): Promise<void> {
  await revokeShareLinkFn({ token });
}

/** The owner's existing links for one version (rules allow owner reads). */
export async function listShareLinks(
  ownerUid: string,
  versionId: string,
): Promise<ShareLinkSummary[]> {
  const snapshot = await getDocs(
    query(
      collection(db, "shareLinks"),
      where("ownerUid", "==", ownerUid),
      where("versionId", "==", versionId),
    ),
  );
  return snapshot.docs.map((d) => ({
    token: d.id,
    url: shareUrlFor(d.id),
    versionLabel: String(d.get("versionLabel") ?? ""),
    revoked: Boolean(d.get("revoked")),
    viewCount: Number(d.get("viewCount") ?? 0),
  }));
}

/** Live comment feed for one version. Returns the unsubscribe function. */
export function subscribeToComments(
  versionId: string,
  onChange: (comments: VersionComment[]) => void,
  onError?: () => void,
): () => void {
  const q = query(
    collection(db, "comments"),
    where("versionId", "==", versionId),
    orderBy("createdAt", "asc"),
  );
  return onSnapshot(
    q,
    (snapshot) => {
      onChange(
        snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            versionId,
            timestampInTrackSeconds: Number(data.timestampInTrackSeconds ?? 0),
            authorType: data.authorType === "owner" ? "owner" : "guest",
            authorDisplayName: String(data.authorDisplayName ?? "Guest"),
            text: String(data.text ?? ""),
            createdAt: (data.createdAt as Timestamp | undefined) ?? null,
          };
        }),
      );
    },
    () => onError?.(),
  );
}

/** Owner comment — written directly, gated by Firestore rules. */
export async function addOwnerComment(input: {
  versionId: string;
  ownerUid: string;
  authorDisplayName: string;
  timestampInTrackSeconds: number;
  text: string;
}): Promise<void> {
  await addDoc(collection(db, "comments"), {
    versionId: input.versionId,
    ownerUid: input.ownerUid,
    timestampInTrackSeconds: input.timestampInTrackSeconds,
    authorType: "owner",
    authorDisplayName: input.authorDisplayName,
    text: input.text,
    createdAt: serverTimestamp(),
  });
}
