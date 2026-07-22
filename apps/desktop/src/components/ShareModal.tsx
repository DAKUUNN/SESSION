import { useCallback, useEffect, useState } from "react";
import type { Track, Version } from "@session/shared-types";
import { api } from "../lib/api";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  storeDropboxToken,
  type ShareLinkSummary,
} from "../lib/sharing";
import type { AccountApi } from "../hooks/useAccount";
import { Modal } from "./Modal";
import "./ShareModal.css";

const PEAK_BUCKETS = 200;

function errorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

interface ShareModalProps {
  track: Track;
  version: Version;
  account: AccountApi;
  onClose: () => void;
  /** Called after the version was uploaded to Dropbox (dropboxPath changed). */
  onVersionUpdated: () => void;
}

/**
 * Creates and manages private guest links for ONE specific version. The
 * link pins the version, so its comment thread stays scoped to what the
 * guest actually heard — even if the artist later changes the master.
 */
export function ShareModal({ track, version, account, onClose, onVersionUpdated }: ShareModalProps) {
  const { user } = account;

  const [links, setLinks] = useState<ShareLinkSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const refreshLinks = useCallback(() => {
    if (!user) return;
    listShareLinks(user.uid, version.id)
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [user, version.id]);

  useEffect(() => {
    refreshLinks();
  }, [refreshLinks]);

  async function handleCreate() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Make sure the audio actually lives in Dropbox (guests stream from
      //    there — Session runs no audio server of its own).
      let dropboxPath = version.dropboxPath ?? null;
      if (!dropboxPath) {
        setBusyLabel("Uploading to your Dropbox…");
        const uploaded = await api.dropboxUploadVersion(version.id);
        dropboxPath = uploaded.dropboxPath ?? null;
        onVersionUpdated();
      }
      if (!dropboxPath) {
        throw new Error("upload finished but no Dropbox path was recorded");
      }

      // 2. Register the Dropbox connection with the server so the guest page
      //    can stream even while this computer is offline.
      setBusyLabel("Preparing secure streaming…");
      const refreshToken = await api.dropboxGetRefreshToken();
      await storeDropboxToken(refreshToken);

      // 3. Waveform peaks travel with the link so the guest page renders
      //    instantly without touching the audio file.
      setBusyLabel("Creating the link…");
      const peaks = await api.generatePeaks(version.file.path, PEAK_BUCKETS).catch(() => []);
      await createShareLink({
        trackTitle: track.title,
        versionId: version.id,
        versionLabel: version.label,
        dropboxPath,
        durationSeconds: version.durationSeconds,
        peaks,
      });
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
      await revokeShareLink(token);
      refreshLinks();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleCopy(link: ShareLinkSummary) {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedToken(link.token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      /* clipboard unavailable — the URL is still visible to copy manually */
    }
  }

  return (
    <Modal title={`Share "${track.title}"`} onClose={onClose} width={560}>
      <div className="share-modal__version tabular">[{version.label.toUpperCase()}]</div>

      {!user ? (
        <p className="share-modal__copy">
          Sign in first (Settings → Account) to create share links — links belong to your
          account so you can revoke them anytime.
        </p>
      ) : (
        <>
          <p className="share-modal__copy">
            Anyone with the link can listen to this exact version and leave timestamped
            comments — no account needed on their side. Comments land right back here,
            pinned to this version.
          </p>

          <button
            type="button"
            className="btn btn--primary"
            onClick={handleCreate}
            disabled={busy}
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
