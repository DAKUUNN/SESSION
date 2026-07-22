import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CoverStyle, Project, ProjectKind } from "@session/shared-types";
import { Modal } from "./Modal";
import { CoverThumb } from "./CoverThumb";
import "./NewProjectModal.css";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

const KIND_OPTIONS: { value: ProjectKind; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "ep", label: "EP" },
  { value: "album", label: "Album" },
  { value: "mixtape", label: "Mixtape" },
];

export interface NewProjectModalResult {
  name: string;
  kind: ProjectKind;
  /** A newly-picked local cover path, or null if the user didn't touch the cover. */
  coverPath: string | null;
  /** Only meaningful (and only asked) when creating — fixed for the project's lifetime after that. */
  coverStyle: CoverStyle;
}

interface NewProjectModalProps {
  /** Present when editing an existing project's basics; omitted when creating a new one. */
  project?: Project | null;
  onClose: () => void;
  onSubmit: (result: NewProjectModalResult) => void;
  busy?: boolean;
}

/**
 * General-purpose "add or edit a project's basics" surface: name, kind, and
 * cover art. Used both for creating a brand-new project (from the sidebar's
 * "+") and for editing an existing one (from the small pencil affordance
 * next to the project title in MainPanel).
 */
export function NewProjectModal({ project, onClose, onSubmit, busy = false }: NewProjectModalProps) {
  const isEdit = !!project;
  const [name, setName] = useState(project?.name ?? "");
  const [kind, setKind] = useState<ProjectKind>(project?.kind ?? "single");
  const [coverStyle, setCoverStyle] = useState<CoverStyle>("album");
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [coverPreviewPath, setCoverPreviewPath] = useState<string | null>(
    project?.coverImage?.path ?? null,
  );

  async function handlePickCover() {
    try {
      const selection = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      setCoverPath(path);
      setCoverPreviewPath(path);
    } catch {
      /* user cancelled the dialog */
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    onSubmit({ name: trimmed, kind, coverPath, coverStyle });
  }

  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <Modal
      title={isEdit ? "Edit project" : "New project"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-project-form" className="btn btn--primary" disabled={!canSubmit}>
            {busy ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <form id="new-project-form" className="new-project-form" onSubmit={handleSubmit}>
        <div className="new-project-form__top">
          {coverPreviewPath ? (
            <div
              className="new-project-form__cover-clickable"
              role="button"
              tabIndex={0}
              onClick={handlePickCover}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handlePickCover();
                }
              }}
              title="Change cover art"
            >
              <CoverThumb cover={{ source: "local", path: coverPreviewPath }} size={96} />
            </div>
          ) : (
            <CoverThumb
              cover={undefined}
              size={96}
              showAddAffordance
              onAdd={handlePickCover}
              title="Add cover art"
            />
          )}

          <div className="new-project-form__fields">
            <div className="field">
              <label className="field__label" htmlFor="new-project-name">
                Name
              </label>
              <input
                id="new-project-name"
                className="text-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
                autoFocus
                required
              />
            </div>

            <div className="field">
              <span className="field__label">Kind</span>
              <div className="kind-picker">
                {KIND_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={"kind-picker__btn" + (kind === opt.value ? " is-selected" : "")}
                    onClick={() => setKind(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {!isEdit ? (
              <div className="field">
                <span className="field__label">Cover style</span>
                <div className="kind-picker">
                  <button
                    type="button"
                    className={"kind-picker__btn" + (coverStyle === "album" ? " is-selected" : "")}
                    onClick={() => setCoverStyle("album")}
                  >
                    Album cover
                  </button>
                  <button
                    type="button"
                    className={"kind-picker__btn" + (coverStyle === "individual" ? " is-selected" : "")}
                    onClick={() => setCoverStyle("individual")}
                  >
                    Individual covers
                  </button>
                </div>
                <span className="field__hint">
                  {coverStyle === "album"
                    ? "One hero cover for the whole release, numbered tracklist."
                    : "Every track keeps its own cover, playlist-style."}{" "}
                  Fixed once the project is created.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </form>
    </Modal>
  );
}
