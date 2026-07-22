/**
 * Live comment feed — shared by the single-track and album guest views.
 * Comments are always scoped by versionId alone; they don't know or care
 * whether the link that brought the guest here was a single-track share
 * link or a whole-project album link.
 */
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  type Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";

export interface Comment {
  id: string;
  timestampInTrackSeconds: number;
  authorType: "guest" | "owner";
  authorDisplayName: string;
  text: string;
  createdAt: Timestamp | null;
}

/** Live comment feed for one version. Returns the unsubscribe function. */
export function subscribeToComments(
  versionId: string,
  onChange: (comments: Comment[]) => void,
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
