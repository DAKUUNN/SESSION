import { useState } from "react";
import { Modal } from "./Modal";

interface NewPlaylistModalProps {
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/**
 * Tiny "name this playlist" prompt. Exists as a real modal rather than
 * `window.prompt` because WKWebView (and Tauri webviews generally) don't
 * reliably support native JS dialogs — `window.prompt` silently does
 * nothing on some platforms, which made "New playlist" look broken.
 */
export function NewPlaylistModal({ onClose, onSubmit }: NewPlaylistModalProps) {
  const [name, setName] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Modal
      title="New playlist"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="new-playlist-form"
            className="btn btn--primary"
            disabled={!name.trim()}
          >
            Create
          </button>
        </>
      }
    >
      <form id="new-playlist-form" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field__label" htmlFor="new-playlist-name">
            Name
          </label>
          <input
            id="new-playlist-name"
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            autoFocus
            required
          />
        </div>
      </form>
    </Modal>
  );
}
