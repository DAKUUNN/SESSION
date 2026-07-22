import { useCallback, useEffect, useState } from "react";
import { api, type DropboxAccountInfo, type DropboxFileEntry } from "../lib/api";
import { formatFileSize } from "../lib/format";
import { Modal } from "./Modal";
import { RefreshIcon } from "./icons";
import "./SettingsModal.css";

// Same audio-extension vocabulary as useFileDrop's local-drag-drop filter —
// duplicated rather than shared, matching how IMAGE_EXTENSIONS is duplicated
// across App.tsx/NewProjectModal rather than pulled into a shared constant.
const AUDIO_EXTENSIONS = ["mp3", "wav", "aiff", "flac", "m4a", "aac"];

function isAudioFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return !!ext && AUDIO_EXTENSIONS.includes(ext);
}

/** Tauri command rejections usually arrive as a plain string (the Rust `Err(String)`); fall back defensively for anything else. */
function errorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

interface SettingsModalProps {
  onClose: () => void;
  /** The app's current "selected project" — imports land here directly, or are disabled when null. */
  selectedProjectId: string | null;
  /** Called after any successful import so the caller can refresh the current project's detail. */
  onImported: () => void;
}

/**
 * Settings surface, currently just the Dropbox integration: connect/disconnect,
 * and browse + import from the app's scoped Dropbox app folder. Reuses the
 * shared Modal shell the same way NewProjectModal/ImportReviewModal do.
 */
export function SettingsModal({ onClose, selectedProjectId, onImported }: SettingsModalProps) {
  const [connection, setConnection] = useState<DropboxAccountInfo | null>(null);
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const [files, setFiles] = useState<DropboxFileEntry[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // Batch-select-and-import support (checkboxes + "Import selected"), on top
  // of the always-available single-row Import button — see PR summary for
  // why both are implemented rather than just one.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [importingPaths, setImportingPaths] = useState<Set<string>>(new Set());
  const [batchImporting, setBatchImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Initial connection status, on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .dropboxGetConnection()
      .then((conn) => {
        if (!cancelled) setConnection(conn);
      })
      .catch(() => {
        if (!cancelled) setConnection(null);
      })
      .finally(() => {
        if (!cancelled) setConnectionLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadFiles = useCallback(() => {
    setFilesLoading(true);
    setFilesError(null);
    api
      .dropboxListAppFolder()
      .then((entries) => setFiles(entries.filter((e) => isAudioFile(e.name))))
      .catch((err) => setFilesError(errorMessage(err)))
      .finally(() => setFilesLoading(false));
  }, []);

  // Load the file list once we know we're connected.
  useEffect(() => {
    if (connection) loadFiles();
  }, [connection, loadFiles]);

  async function handleConnect() {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const info = await api.dropboxConnect();
      setConnection(info);
    } catch (err) {
      setConnectError(errorMessage(err));
    } finally {
      setConnectBusy(false);
    }
  }

  async function handleDisconnect() {
    setDisconnectBusy(true);
    setDisconnectError(null);
    try {
      await api.dropboxDisconnect();
      setConnection(null);
      setFiles(null);
      setSelectedPaths(new Set());
    } catch (err) {
      setDisconnectError(errorMessage(err));
    } finally {
      setDisconnectBusy(false);
    }
  }

  function toggleSelected(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function importOne(file: DropboxFileEntry) {
    if (!selectedProjectId) return;
    setImportError(null);
    setImportingPaths((prev) => new Set(prev).add(file.path));
    try {
      await api.dropboxImportFile(selectedProjectId, file.path, file.rev, file.name);
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.delete(file.path);
        return next;
      });
      onImported();
    } catch (err) {
      setImportError(`Couldn't import "${file.name}" — ${errorMessage(err)}`);
    } finally {
      setImportingPaths((prev) => {
        const next = new Set(prev);
        next.delete(file.path);
        return next;
      });
    }
  }

  async function importSelected() {
    if (!selectedProjectId || selectedPaths.size === 0 || !files) return;
    const targets = files.filter((f) => selectedPaths.has(f.path));
    setBatchImporting(true);
    setImportError(null);
    const failures: string[] = [];
    for (const file of targets) {
      setImportingPaths((prev) => new Set(prev).add(file.path));
      try {
        await api.dropboxImportFile(selectedProjectId, file.path, file.rev, file.name);
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          next.delete(file.path);
          return next;
        });
      } catch (err) {
        failures.push(`"${file.name}" — ${errorMessage(err)}`);
      } finally {
        setImportingPaths((prev) => {
          const next = new Set(prev);
          next.delete(file.path);
          return next;
        });
      }
    }
    onImported();
    setBatchImporting(false);
    if (failures.length > 0) {
      setImportError(`Some files failed to import: ${failures.join("; ")}`);
    }
  }

  const isConnected = !!connection;
  const hasSelection = selectedPaths.size > 0;
  const noProjectHint = "Select a project first";

  return (
    <Modal title="Settings" onClose={onClose} width={600}>
      <div className="settings-section">
        <div className="settings-section__head">
          <span className="mono-label">Dropbox</span>
        </div>

        {!connectionLoaded ? (
          <div className="settings-status">Checking connection…</div>
        ) : isConnected ? (
          <div className="settings-dropbox__connected">
            <div className="settings-dropbox__account">
              Connected as <strong>{connection.displayName}</strong> ({connection.email})
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleDisconnect}
              disabled={disconnectBusy}
            >
              {disconnectBusy ? "Disconnecting…" : "Disconnect"}
            </button>
            {disconnectError ? <div className="settings-error">{disconnectError}</div> : null}
          </div>
        ) : (
          <div className="settings-dropbox__disconnected">
            <p className="settings-dropbox__copy">
              Connect your Dropbox to sync tracks across devices. Session only ever sees its own
              app folder there — never your full Dropbox.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleConnect}
              disabled={connectBusy}
            >
              {connectBusy ? "Waiting for approval in your browser…" : "Connect Dropbox"}
            </button>
            {connectError ? (
              <div className="settings-error">
                {connectError}{" "}
                <button type="button" className="settings-error__retry" onClick={handleConnect}>
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {isConnected ? (
        <div className="settings-section">
          <div className="settings-section__head">
            <span className="mono-label">App folder</span>
            <div className="settings-section__actions">
              {hasSelection ? (
                <button
                  type="button"
                  className="btn btn--secondary settings-import-selected"
                  onClick={importSelected}
                  disabled={batchImporting || !selectedProjectId}
                  title={!selectedProjectId ? noProjectHint : undefined}
                >
                  {batchImporting ? "Importing…" : `Import selected (${selectedPaths.size})`}
                </button>
              ) : null}
              <button
                type="button"
                className="icon-btn"
                onClick={loadFiles}
                disabled={filesLoading}
                title="Refresh"
              >
                <RefreshIcon />
              </button>
            </div>
          </div>

          {!selectedProjectId ? (
            <div className="settings-hint">Select a project first to enable importing.</div>
          ) : null}

          {filesLoading ? (
            <div className="settings-status">Loading files…</div>
          ) : filesError ? (
            <div className="settings-error">{filesError}</div>
          ) : !files || files.length === 0 ? (
            <div className="settings-status">No audio files in your app folder yet.</div>
          ) : (
            <div className="dropbox-file-list">
              {files.map((file) => {
                const importing = importingPaths.has(file.path);
                return (
                  <div className="dropbox-file-row" key={file.path}>
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(file.path)}
                      onChange={() => toggleSelected(file.path)}
                      disabled={!selectedProjectId || importing || batchImporting}
                    />
                    <span className="dropbox-file-row__name">{file.name}</span>
                    <span className="dropbox-file-row__size tabular">
                      {formatFileSize(file.size)}
                    </span>
                    <button
                      type="button"
                      className="btn btn--secondary dropbox-file-row__import"
                      onClick={() => importOne(file)}
                      disabled={!selectedProjectId || importing || batchImporting}
                      title={!selectedProjectId ? noProjectHint : undefined}
                    >
                      {importing ? "Importing…" : "Import"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {importError ? <div className="settings-error">{importError}</div> : null}
        </div>
      ) : null}
    </Modal>
  );
}
