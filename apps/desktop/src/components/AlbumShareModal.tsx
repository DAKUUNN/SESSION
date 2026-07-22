import type { Project, Track, Version } from "@session/shared-types";
import type { AccountApi } from "../hooks/useAccount";
import { Modal } from "./Modal";

interface AlbumShareModalProps {
  project: Project;
  tracks: Track[];
  versionsByTrack: Record<string, Version[]>;
  account: AccountApi;
  onClose: () => void;
  /** Called after any version was uploaded to Dropbox during the share flow. */
  onVersionsUpdated: () => void;
}

/**
 * STUB — replaced by the album/EP-level share feature: bundles every
 * track's current default version into one guest link, mirroring
 * ShareModal's single-track flow (upload-if-needed, register the Dropbox
 * token, create the link, list/copy/revoke existing album links).
 */
export function AlbumShareModal({ project, onClose }: AlbumShareModalProps) {
  return (
    <Modal title={`Share "${project.name}"`} onClose={onClose} width={560}>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Whole-{project.kind} sharing is coming shortly.
      </p>
    </Modal>
  );
}
