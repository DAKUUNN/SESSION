import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CoverStyle, Playlist, Project, Track, Version } from "@session/shared-types";
import { api, type ProjectDetail } from "./lib/api";
import { groupFilesByBaseName } from "./lib/grouping";
import type { ImportGroup } from "./lib/grouping";
import { usePlayer } from "./hooks/usePlayer";
import { useAccount } from "./hooks/useAccount";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { MainPanel } from "./components/MainPanel";
import { PlayerBar } from "./components/PlayerBar";
import { EmptyState } from "./components/EmptyState";
import { NewProjectModal, type NewProjectModalResult } from "./components/NewProjectModal";
import { ImportReviewModal } from "./components/ImportReviewModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShareModal } from "./components/ShareModal";
import { AlbumShareModal } from "./components/AlbumShareModal";
import "./App.css";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

function favoriteKey(trackId: string, versionId?: string) {
  return `${trackId}::${versionId ?? "_"}`;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);

  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);

  // New/Edit Project modal — same surface for both flows (see NewProjectModal).
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectModalBusy, setProjectModalBusy] = useState(false);

  // Drag-dropped (or otherwise grouped) files awaiting review before import.
  const [pendingImportGroups, setPendingImportGroups] = useState<ImportGroup[] | null>(null);

  // Settings modal (Dropbox connection + app-folder browsing/import).
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Share-link modal target: one track + the specific version being shared.
  const [shareTarget, setShareTarget] = useState<{ track: Track; version: Version } | null>(null);
  // Whole-project ("share this whole EP/album") modal — see AlbumShareModal.
  const [showAlbumShareModal, setShowAlbumShareModal] = useState(false);

  const player = usePlayer();
  // Account + licensing lives app-wide (not inside the modal) so the license
  // sync with Firestore runs on startup, not only when Settings is open.
  const account = useAccount();

  // Initial data load. Every call is defensive: sibling agents are still
  // wiring up some of these commands, so a failure here should not crash
  // the shell — it should just leave that section empty.
  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoaded(true));
    api
      .listPlaylists()
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
    api
      .listFavorites()
      .then((favs) => {
        setFavorites(new Set(favs.map((f) => favoriteKey(f.trackId, f.versionId))));
      })
      .catch(() => {});
  }, []);

  // Pick a default selected project once the list arrives.
  useEffect(() => {
    if (selectedProjectId === null && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // Load the detail payload whenever the selected project changes.
  useEffect(() => {
    if (!selectedProjectId) {
      setProjectDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getProjectDetail(selectedProjectId)
      .then((detail) => {
        if (!cancelled) setProjectDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setProjectDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(id);
  }, []);

  const handleChangeCoverStyle = useCallback(
    (style: CoverStyle) => {
      if (!selectedProjectId) return;
      setProjectDetail((prev) =>
        prev ? { ...prev, project: { ...prev.project, coverStyle: style } } : prev,
      );
      setProjects((prev) =>
        prev.map((p) => (p.id === selectedProjectId ? { ...p, coverStyle: style } : p)),
      );
      api.setProjectCoverStyle(selectedProjectId, style).catch(() => {});
    },
    [selectedProjectId],
  );

  const isFavorite = useCallback(
    (trackId: string, versionId?: string) => favorites.has(favoriteKey(trackId, versionId)),
    [favorites],
  );

  const handleToggleFavorite = useCallback((trackId: string, versionId?: string) => {
    const key = favoriteKey(trackId, versionId);
    // optimistic flip
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    api.toggleFavorite(trackId, versionId).catch(() => {
      // revert on failure
      setFavorites((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    });
  }, []);

  const handleOpenNewProjectModal = useCallback(() => {
    setEditingProject(null);
    setShowProjectModal(true);
  }, []);

  const handleOpenEditProjectModal = useCallback(() => {
    if (!projectDetail) return;
    setEditingProject(projectDetail.project);
    setShowProjectModal(true);
  }, [projectDetail]);

  const handleCloseProjectModal = useCallback(() => {
    setShowProjectModal(false);
    setEditingProject(null);
  }, []);

  const handleSubmitProjectModal = useCallback(
    async (result: NewProjectModalResult) => {
      setProjectModalBusy(true);
      try {
        if (editingProject) {
          // Edit path. The cover is genuinely persisted via
          // set_project_cover_image. Name/kind have no backend
          // rename/update-kind command yet, so those two are applied as a
          // session-only optimistic UI update — a known gap, documented in
          // the PR summary, rather than silently inventing an endpoint.
          const projectId = editingProject.id;
          if (result.coverPath) {
            await api.setProjectCoverImage(projectId, "local", result.coverPath).catch(() => {});
          }
          const coverImage = result.coverPath
            ? { source: "local" as const, path: result.coverPath }
            : editingProject.coverImage;
          setProjects((prev) =>
            prev.map((p) =>
              p.id === projectId ? { ...p, name: result.name, kind: result.kind, coverImage } : p,
            ),
          );
          setProjectDetail((prev) =>
            prev && prev.project.id === projectId
              ? { ...prev, project: { ...prev.project, name: result.name, kind: result.kind, coverImage } }
              : prev,
          );
        } else {
          const project = await api.createProject(result.name, result.kind);
          if (result.coverPath) {
            await api.setProjectCoverImage(project.id, "local", result.coverPath).catch(() => {});
          }
          const coverImage = result.coverPath
            ? { source: "local" as const, path: result.coverPath }
            : project.coverImage;
          setProjects((prev) => [...prev, { ...project, coverImage }]);
          setSelectedProjectId(project.id);
        }
      } catch {
        /* backend not ready yet — the modal simply closes without effect */
      } finally {
        setProjectModalBusy(false);
        setShowProjectModal(false);
        setEditingProject(null);
      }
    },
    [editingProject],
  );

  const handleImportPaths = useCallback(
    (paths: string[]) => {
      if (!selectedProjectId || paths.length === 0) return;
      setPendingImportGroups(groupFilesByBaseName(paths));
    },
    [selectedProjectId],
  );

  const handleCancelImportReview = useCallback(() => {
    setPendingImportGroups(null);
  }, []);

  const handleConfirmImportReview = useCallback(
    async (groups: ImportGroup[]) => {
      if (!selectedProjectId) return;
      setImportBusy(true);
      try {
        await api.importGroupedFiles(selectedProjectId, groups);
        const detail = await api.getProjectDetail(selectedProjectId);
        setProjectDetail(detail);
      } catch {
        /* backend not ready yet, or nothing to import */
      } finally {
        setImportBusy(false);
        setPendingImportGroups(null);
      }
    },
    [selectedProjectId],
  );

  const handleAddProjectCover = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const selection = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const coverImage = { source: "local" as const, path };
      setProjectDetail((prev) =>
        prev ? { ...prev, project: { ...prev.project, coverImage } } : prev,
      );
      setProjects((prev) =>
        prev.map((p) => (p.id === selectedProjectId ? { ...p, coverImage } : p)),
      );
      await api.setProjectCoverImage(selectedProjectId, "local", path);
    } catch {
      /* user cancelled the dialog, or the backend isn't ready yet */
    }
  }, [selectedProjectId]);

  const handleAddTrackCover = useCallback(async (trackId: string) => {
    try {
      const selection = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const coverImage = { source: "local" as const, path };
      setProjectDetail((prev) =>
        prev
          ? { ...prev, tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, coverImage } : t)) }
          : prev,
      );
      await api.setTrackCoverImage(trackId, "local", path);
    } catch {
      /* user cancelled the dialog, or the backend isn't ready yet */
    }
  }, []);

  const handleSwitchDefaultVersion = useCallback((trackId: string, versionId: string) => {
    // Optimistic: reflect the new default immediately, matching the
    // favorites/cover-style pattern above.
    setProjectDetail((prev) =>
      prev
        ? {
            ...prev,
            tracks: prev.tracks.map((t) =>
              t.id === trackId ? { ...t, defaultVersionId: versionId } : t,
            ),
          }
        : prev,
    );
    api.setDefaultVersion(trackId, versionId).catch(() => {});
  }, []);

  const handleNewPlaylist = useCallback(() => {
    const name = window.prompt("Playlist name");
    if (!name) return;
    api
      .createPlaylist(name)
      .then((playlist) => {
        setPlaylists((prev) => [...prev, playlist]);
        setSelectedPlaylistId(playlist.id);
      })
      .catch(() => {});
  }, []);

  const handleOpenSettings = useCallback(() => setShowSettingsModal(true), []);
  const handleCloseSettings = useCallback(() => setShowSettingsModal(false), []);

  // After a Dropbox import lands in the currently-selected project, refresh
  // its detail — same api.getProjectDetail + setProjectDetail pattern as
  // handleConfirmImportReview above — so the new track shows up immediately.
  const handleDropboxImported = useCallback(() => {
    if (!selectedProjectId) return;
    api
      .getProjectDetail(selectedProjectId)
      .then(setProjectDetail)
      .catch(() => {});
  }, [selectedProjectId]);

  const handleShare = useCallback((track: Track, version: Version) => {
    setShareTarget({ track, version });
  }, []);

  const hasProjects = projects.length > 0;

  const mainContent = useMemo(() => {
    if (!projectsLoaded) return null;
    if (!hasProjects) {
      return <EmptyState onImport={handleOpenNewProjectModal} busy={importBusy} />;
    }
    if (!projectDetail) return null;
    return (
      <MainPanel
        project={projectDetail.project}
        tracks={projectDetail.tracks}
        versionsByTrack={projectDetail.versionsByTrack}
        onChangeCoverStyle={handleChangeCoverStyle}
        isFavorite={isFavorite}
        onToggleFavorite={handleToggleFavorite}
        player={player}
        onSwitchDefaultVersion={handleSwitchDefaultVersion}
        onImportPaths={handleImportPaths}
        onEditProject={handleOpenEditProjectModal}
        onAddProjectCover={handleAddProjectCover}
        onAddTrackCover={handleAddTrackCover}
        onShare={handleShare}
        onShareAlbum={() => setShowAlbumShareModal(true)}
        onNewProject={handleOpenNewProjectModal}
      />
    );
  }, [
    projectsLoaded,
    hasProjects,
    importBusy,
    handleOpenNewProjectModal,
    projectDetail,
    handleChangeCoverStyle,
    isFavorite,
    handleToggleFavorite,
    player,
    handleSwitchDefaultVersion,
    handleImportPaths,
    handleOpenEditProjectModal,
    handleAddProjectCover,
    handleAddTrackCover,
    handleShare,
  ]);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          onNewProject={handleOpenNewProjectModal}
          playlists={playlists}
          selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={setSelectedPlaylistId}
          onNewPlaylist={handleNewPlaylist}
          onOpenSettings={handleOpenSettings}
        />
        {mainContent}
      </div>
      <PlayerBar
        nowPlaying={player.nowPlaying}
        status={player.status}
        cover={player.nowPlaying?.cover}
        onTogglePlay={player.togglePlay}
        onSeek={player.seek}
        volume={player.volume}
        onVolumeChange={player.setVolume}
      />

      {showProjectModal ? (
        <NewProjectModal
          project={editingProject}
          busy={projectModalBusy}
          onClose={handleCloseProjectModal}
          onSubmit={handleSubmitProjectModal}
        />
      ) : null}

      {pendingImportGroups ? (
        <ImportReviewModal
          initialGroups={pendingImportGroups}
          busy={importBusy}
          onClose={handleCancelImportReview}
          onConfirm={handleConfirmImportReview}
        />
      ) : null}

      {showSettingsModal ? (
        <SettingsModal
          onClose={handleCloseSettings}
          selectedProjectId={selectedProjectId}
          onImported={handleDropboxImported}
          account={account}
        />
      ) : null}

      {shareTarget ? (
        <ShareModal
          track={shareTarget.track}
          version={shareTarget.version}
          versions={projectDetail?.versionsByTrack[shareTarget.track.id] ?? [shareTarget.version]}
          account={account}
          onClose={() => setShareTarget(null)}
          onVersionUpdated={handleDropboxImported}
        />
      ) : null}

      {showAlbumShareModal && projectDetail ? (
        <AlbumShareModal
          project={projectDetail.project}
          tracks={projectDetail.tracks}
          versionsByTrack={projectDetail.versionsByTrack}
          account={account}
          onClose={() => setShowAlbumShareModal(false)}
          onVersionsUpdated={handleDropboxImported}
        />
      ) : null}
    </div>
  );
}

export default App;
