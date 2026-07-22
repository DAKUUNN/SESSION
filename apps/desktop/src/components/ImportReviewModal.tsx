import { useState } from "react";
import type { ImportGroup } from "../lib/grouping";
import { Modal } from "./Modal";
import "./ImportReviewModal.css";

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

interface ImportReviewModalProps {
  initialGroups: ImportGroup[];
  onClose: () => void;
  onConfirm: (groups: ImportGroup[]) => void;
  busy?: boolean;
}

/**
 * Lets the user review (and tweak) the groups `groupFilesByBaseName` detected
 * from a drag-dropped batch before anything is written to the backend —
 * titles and version labels are editable, and any version can be marked as
 * the group's default/master. Cancelling discards everything; nothing here
 * touches the backend until Confirm.
 */
export function ImportReviewModal({
  initialGroups,
  onClose,
  onConfirm,
  busy = false,
}: ImportReviewModalProps) {
  const [groups, setGroups] = useState<ImportGroup[]>(initialGroups);

  function updateTitle(groupIndex: number, title: string) {
    setGroups((prev) => prev.map((g, i) => (i === groupIndex ? { ...g, title } : g)));
  }

  function updateLabel(groupIndex: number, versionIndex: number, label: string) {
    setGroups((prev) =>
      prev.map((g, i) =>
        i === groupIndex
          ? {
              ...g,
              versions: g.versions.map((v, vi) => (vi === versionIndex ? { ...v, label } : v)),
            }
          : g,
      ),
    );
  }

  function setDefaultVersion(groupIndex: number, versionIndex: number) {
    setGroups((prev) =>
      prev.map((g, i) => (i === groupIndex ? { ...g, defaultVersionIndex: versionIndex } : g)),
    );
  }

  function handleConfirm() {
    if (busy || groups.length === 0) return;
    onConfirm(groups);
  }

  return (
    <Modal
      title={`Review import (${groups.length} track${groups.length === 1 ? "" : "s"})`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleConfirm}
            disabled={busy || groups.length === 0}
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <div className="import-review">
        {groups.map((group, gi) => (
          <div className="import-group" key={gi}>
            <input
              className="text-input import-group__title"
              value={group.title}
              onChange={(e) => updateTitle(gi, e.target.value)}
              placeholder="Track title"
            />
            <div className="import-group__versions">
              {group.versions.map((version, vi) => {
                const isDefault = vi === group.defaultVersionIndex;
                return (
                  <div className="import-version-row" key={vi}>
                    <button
                      type="button"
                      className={"import-version-row__radio" + (isDefault ? " is-selected" : "")}
                      onClick={() => setDefaultVersion(gi, vi)}
                      title={isDefault ? "Master version" : "Set as master"}
                    />
                    <input
                      className="text-input import-version-row__label"
                      value={version.label}
                      onChange={(e) => updateLabel(gi, vi, e.target.value)}
                    />
                    <span className="import-version-row__filename">{basename(version.path)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
