import { convertFileSrc } from "@tauri-apps/api/core";
import type { FileRef } from "@session/shared-types";
import "./CoverThumb.css";

interface CoverThumbProps {
  cover?: FileRef | null;
  size: number;
  /** Renders a "+" affordance in the placeholder state to hint that a cover can be added. */
  showAddAffordance?: boolean;
  title?: string;
}

/** Small square cover art tile, falling back to a dashed placeholder when no cover is set. */
export function CoverThumb({
  cover,
  size,
  showAddAffordance = false,
  title,
}: CoverThumbProps) {
  const style = { width: size, height: size };

  if (cover?.path) {
    return (
      <div className="cover-thumb" style={style} title={title}>
        <img src={convertFileSrc(cover.path)} alt="" draggable={false} />
      </div>
    );
  }

  if (!showAddAffordance) {
    return <div className="cover-thumb cover-thumb--placeholder" style={style} title={title} />;
  }

  return (
    <button
      type="button"
      className="cover-thumb cover-thumb--placeholder"
      style={style}
      title={title ?? "Cover art"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  );
}
