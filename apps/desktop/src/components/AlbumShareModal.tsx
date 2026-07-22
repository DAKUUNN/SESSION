import { useCallback, useEffect, useState } from "react";
import type { Project, Track, Version } from "@session/shared-types";
import { api } from "../lib/api";
import {
  albumShareUrlFor,
  createAlbumShareLink,
  listAlbumShareLinks,
  revokeAlbumShareLink,
  storeDropboxToken,
  type AlbumShareLinkSummary,
} from "../lib/sharing";
import type { AccountApi } from "../hooks/useAccount";
import { Modal } from "./Modal";
import "./ShareModal.css";
import "./AlbumShareModal.css";

const PEAK_BUCKETS = 200;

function errorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

interface AlbumShareModalProps {
  project: Project;
  tracks: Track[];
  versionsByTrack: Record<string, Version[]>;
  account: AccountApi;
  onClose: () => void;
  /** Called after any version was uploaded to Dropbox during the share flow. */
  onVersionsUpdated: () => void;
}

/** Picks each track's current default/master version (falling back to its
 *  first version if no default is set) — the same version that would play
 *  in the main app's tracklist. */
function defaultVersionFor(track: Track, versions: Version[] | undefined): Version | null {
  if (!versions || versions.length === 0) return null;
  return versions.find((v) => v.id === track.defaultVersionId) ?? versions[0];
}

/**
 * Creates and manages private guest links for a whole project (EP/album):
 * bundles every track's current default version into one link, mirroring
 * ShareModal's single-track flow but fanned out over the whole tracklist —
 * upload-if-needed and generate peaks per track, register the Dropbox
 * connection once, then mint one token covering every track.
 */
export function AlbumShareModal({
  project,
  tracks,
  versionsByTrack,
  account,
  onClose,
  onVersionsUpdated,
}: AlbumShareModalProps) {
  const { user } = account;

  const [links, setLinks] = useState<AlbumShareLinkSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const shareableTracks = tracks
    .map((track) => ({ track, version: defaultVersionFor(track, versionsByTrack[track.id]) }))
    .filter((entry): entry is { track: Track; version: Version } => entry.version !== null);

  const refreshLinks = useCallback(() => {
    if (!user) return;
    listAlbumShareLinks(user.uid)
      .then(setLinks)
      .catch((err) => {
        // Surfaced rather than swallowed: a link can be created successfully
        // (see the optimistic prepend in handleCreate) even if this refresh
        // itself fails, so silently clearing the list would hide a real
        // problem behind what looks like "nothing happened."
        setLinks((prev) => prev ?? []);
        setError(errorMessage(err));
      });
  }, [user]);

  useEffect(() => {
    refreshLinks();
  }, [refreshLinks]);

  async function handleCreate() {
    if (!user) return;
    if (shareableTracks.length === 0) {
      setError("This project has no tracks with a version to share yet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let anyUploaded = false;
      const trackInputs: {
        title: string;
        versionId: string;
        versionLabel: string;
        dropboxPath: string;
        durationSeconds: number;
        peaks: number[];
      }[] = [];

      // 1 & 2. For every track: make sure the audio lives in Dropbox (guests
      // stream from there), then generate its waveform peaks.
      for (let i = 0; i < shareableTracks.length; i++) {
        const { track, version } = shareableTracks[i];
        setBusyLabel(`Uploading ${i + 1} of ${shareableTracks.length}…`);

        let dropboxPath = version.dropboxPath ?? null;
        if (!dropboxPath) {
          const uploaded = await api.dropboxUploadVersion(version.id);
          dropboxPath = uploaded.dropboxPath ?? null;
          anyUploaded = true;
        }
        if (!dropboxPath) {
          throw new Error(`upload finished but no Dropbox path was recorded for "${track.title}"`);
        }

        setBusyLabel(`Analyzing waveform ${i + 1} of ${shareableTracks.length}…`);
        const peaks = await api.generatePeaks(version.file.path, PEAK_BUCKETS).catch(() => []);

        trackInputs.push({
          title: track.title,
          versionId: version.id,
          versionLabel: version.label,
          dropboxPath,
          durationSeconds: version.durationSeconds,
          peaks,
        });
      }

      if (anyUploaded) onVersionsUpdated();

      // 3. Register the Dropbox connection with the server (once) so the
      //    guest page can stream even while this computer is offline.
      setBusyLabel("Preparing secure streaming…");
      const refreshToken = await api.dropboxGetRefreshToken();
      await storeDropboxToken(refreshToken);

      setBusyLabel("Creating the link…");
      const token = await createAlbumShareLink({
        projectName: project.name,
        projectKind: project.kind,
        tracks: trackInputs,
      });
      // Show the new link immediately from the create response, rather than
      // waiting on a follow-up Firestore read that could lag or fail —
      // that's what made a successfully-created link look like it never
      // appeared at all.
      setLinks((prev) => [
        { token, url: albumShareUrlFor(token), projectName: project.name, revoked: false, viewCount: 0 },
        ...(prev ?? []),
      ]);
      refreshLinks();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function handleRevoke(token: string) {
    setError(null);
    try {
      await revokeAlbumShareLink(token);
      refreshLinks();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleCopy(link: AlbumShareLinkSummary) {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedToken(link.token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      /* clipboard unavailable — the URL is still visible to copy manually */
    }
  }

  return (
    <Modal title={`Share "${project.name}"`} onClose={onClose} width={560}>
      <div className="share-modal__version album-share-modal__track-count tabular">
        {shareableTracks.length} {shareableTracks.length === 1 ? "TRACK" : "TRACKS"}
      </div>

      {!user ? (
        <p className="share-modal__copy">
          Sign in first (Settings → Account) to create share links — links belong to your
          account so you can revoke them anytime.
        </p>
      ) : (
        <>
          <p className="share-modal__copy">
            Anyone with the link can listen to every track's current version and leave
            timestamped comments on each — no account needed on their side. Comments land
            right back here, pinned to whichever version was shared.
          </p>

          {shareableTracks.length > 0 ? (
            <ul className="album-share-modal__tracklist">
              {shareableTracks.map(({ track, version }, i) => (
                <li key={track.id} className="album-share-modal__track">
                  <span className="album-share-modal__track-index tabular">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="album-share-modal__track-title">{track.title}</span>
                  <span className="album-share-modal__track-version tabular">
                    [{version.label.toUpperCase()}]
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <button
            type="button"
            className="btn btn--primary"
            onClick={handleCreate}
            disabled={busy || shareableTracks.length === 0}
          >
            {busy ? busyLabel || "Working…" : "Create share link"}
          </button>

          {links === null ? (
            <div className="share-modal__status">Loading your links…</div>
          ) : links.length > 0 ? (
            <div className="share-modal__links">
              {links.map((link) => (
                <div
                  key={link.token}
                  className={"share-modal__link" + (link.revoked ? " is-revoked" : "")}
                >
                  <span className="share-modal__url" title={link.url}>
                    {link.url}
                  </span>
                  <span className="share-modal__views tabular">
                    {link.viewCount} {link.viewCount === 1 ? "play" : "plays"}
                  </span>
                  {link.revoked ? (
                    <span className="share-modal__revoked tabular">[REVOKED]</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary share-modal__action"
                        onClick={() => handleCopy(link)}
                      >
                        {copiedToken === link.token ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary share-modal__action"
                        onClick={() => handleRevoke(link.token)}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {error ? <div className="share-modal__error">{error}</div> : null}
    </Modal>
  );
}
