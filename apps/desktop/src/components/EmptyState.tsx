import "./EmptyState.css";

interface EmptyStateProps {
  onImport: () => void;
  busy: boolean;
}

export function EmptyState({ onImport, busy }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__eyebrow">Peak-Sense</div>
      <div className="empty-state__title">Bring in your first tracks to start a session.</div>
      <div className="empty-state__subtitle">
        Import local audio files to create your first project. Session keeps every version,
        waveform, and take organized in one place.
      </div>
      <button className="empty-state__cta" onClick={onImport} disabled={busy}>
        {busy ? "Importing…" : "Import files"}
      </button>
    </div>
  );
}
