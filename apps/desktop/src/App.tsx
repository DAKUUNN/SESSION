import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Playlist, PlaylistTrackEntry, Project, Track, Version } from "@session/shared-types";
import { api, type ProjectDetail } from "./lib/api";
import { groupFilesByBaseName } from "./lib/grouping";
import type { ImportGroup } from "./lib/grouping";
import { FAVORITES_PLAYLIST_ID } from "./lib/constants";
import { usePlayer } from "./hooks/usePlayer";
import { useAccount } from "./hooks/useAccount";
import {
  isAdaptiveAccentEnabled,
  persistAdaptiveAccentEnabled,
  useAdaptiveAccent,
} from "./hooks/useAdaptiveAccent";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { MainPanel } from "./components/MainPanel";
import { PlaylistView } from "./components/PlaylistView";
import { PlayerBar } from "./components/PlayerBar";
import { EmptyState } from "./components/EmptyState";
import { NewProjectModal, type NewProjectModalResult } from "./components/NewProjectModal";
import { NewPlaylistModal } from "./components/NewPlaylistModal";
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
  const [playlistEntries, setPlaylistEntries] = useState<PlaylistTrackEntry[]>([]);

  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [downloadingVersionId, setDownloadingVersionId] = useState<string | null>(null);

  // Experimental "match accent color to cover art" appearance toggle — a
  // local-only UI preference (not synced anywhere), see useAdaptiveAccent.
  const [adaptiveAccentEnabled, setAdaptiveAccentEnabledState] = useState(isAdaptiveAccentEnabled);
  const handleToggleAdaptiveAccent = useCallback((enabled: boolean) => {
    setAdaptiveAccentEnabledState(enabled);
    persistAdaptiveAccentEnabled(enabled);
  }, []);

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

  // Prefer the currently-playing track's cover; fall back to the selected
  // project's so browsing an album previews its color before pressing play.
  useAdaptiveAccent(
    player.nowPlaying?.cover ?? projectDetail?.project.coverImage ?? null,
    adaptiveAccentEnabled,
  );

  // Spacebar play/pause, ignored while typing in a text field (comments,
  // playlist/project names, the license key input, etc.) so it doesn't
  // hijack normal typing of literal spaces.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      e.preventDefault();
      player.togglePlay();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [player]);

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

  // Pick a default selected project once the list arrives — but not while a
  // playlist is the intentionally-selected view, or this would immediately
  // stomp back over it every time selectedProjectId is cleared to view one.
  useEffect(() => {
    if (selectedProjectId === null && selectedPlaylistId === null && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId, selectedPlaylistId]);

  // Loads the flat, resolved track list for whichever playlist (real or the
  // pinned Favorites pseudo-playlist) is currently selected.
  const loadPlaylistEntries = useCallback(() => {
    if (!selectedPlaylistId) {
      setPlaylistEntries([]);
      return;
    }
    const loader =
      selectedPlaylistId === FAVORITES_PLAYLIST_ID
        ? api.listFavoriteTracks()
        : api.getPlaylistDetail(selectedPlaylistId);
    loader.then(setPlaylistEntries).catch(() => setPlaylistEntries([]));
  }, [selectedPlaylistId]);

  useEffect(() => {
    loadPlaylistEntries();
  }, [loadPlaylistEntries]);

  // The Favorites pseudo-playlist has no dedicated backing table to refetch
  // from on mutation — it's derived from `favorites`, so re-fetch whenever
  // that changes (a heart toggled anywhere in the app) while it's open.
  useEffect(() => {
    if (selectedPlaylistId === FAVORITES_PLAYLIST_ID) loadPlaylistEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites]);

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
    setSelectedPlaylistId(null);
  }, []);

  const handleSelectPlaylist = useCallback((id: string) => {
    setSelectedPlaylistId(id);
    setSelectedProjectId(null);
  }, []);

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
          await api.setProjectCoverStyle(project.id, result.coverStyle).catch(() => {});
          const coverImage = result.coverPath
            ? { source: "local" as const, path: result.coverPath }
            : project.coverImage;
          setProjects((prev) => [...prev, { ...project, coverImage, coverStyle: result.coverStyle }]);
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

  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);

  const handleNewPlaylist = useCallback(() => {
    setShowNewPlaylistModal(true);
  }, []);

  const handleSubmitNewPlaylist = useCallback((name: string) => {
    setShowNewPlaylistModal(false);
    api
      .createPlaylist(name)
      .then((playlist) => {
        setPlaylists((prev) => [...prev, playlist]);
        setSelectedPlaylistId(playlist.id);
        setSelectedProjectId(null);
      })
      .catch(() => {});
  }, []);

  const handleAddToPlaylist = useCallback(
    (playlistId: string, trackId: string, versionId?: string) => {
      api
        .addToPlaylist(playlistId, trackId, versionId)
        .then(() => {
          if (playlistId === selectedPlaylistId) loadPlaylistEntries();
        })
        .catch(() => {});
    },
    [selectedPlaylistId, loadPlaylistEntries],
  );

  const handleCreatePlaylistWithTrack = useCallback(
    (name: string, trackId: string, versionId?: string) => {
      api
        .createPlaylist(name)
        .then(async (playlist) => {
          setPlaylists((prev) => [...prev, playlist]);
          await api.addToPlaylist(playlist.id, trackId, versionId);
        })
        .catch(() => {});
    },
    [],
  );

  const handleRemoveFromPlaylist = useCallback(
    (trackId: string, versionId?: string) => {
      if (!selectedPlaylistId) return;
      if (selectedPlaylistId === FAVORITES_PLAYLIST_ID) {
        handleToggleFavorite(trackId, versionId);
        return;
      }
      api
        .removeFromPlaylist(selectedPlaylistId, trackId, versionId)
        .then(loadPlaylistEntries)
        .catch(() => {});
    },
    [selectedPlaylistId, loadPlaylistEntries],
  );

  const handleRenamePlaylist = useCallback(
    (name: string) => {
      if (!selectedPlaylistId || selectedPlaylistId === FAVORITES_PLAYLIST_ID) return;
      setPlaylists((prev) => prev.map((p) => (p.id === selectedPlaylistId ? { ...p, name } : p)));
      api.renamePlaylist(selectedPlaylistId, name).catch(() => {});
    },
    [selectedPlaylistId],
  );

  const handleDeletePlaylist = useCallback(() => {
    if (!selectedPlaylistId || selectedPlaylistId === FAVORITES_PLAYLIST_ID) return;
    const id = selectedPlaylistId;
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    setSelectedPlaylistId(null);
    api.deletePlaylist(id).catch(() => {});
  }, [selectedPlaylistId]);

  // Reflects one freshly-downloaded version (file_source flipped from
  // "dropbox" to "local") back into projectDetail — shared by the single-row
  // download button and the whole-project download loop below. Downloading
  // never changes the version's id, so a version's comment thread (queried
  // by versionId in WaveformPlayer) keeps showing exactly the same comments
  // afterward — nothing to reconcile there.
  const applyDownloadedVersion = useCallback((updated: Version) => {
    setProjectDetail((prev) => {
      if (!prev) return prev;
      const versionsByTrack = { ...prev.versionsByTrack };
      const owner = Object.keys(versionsByTrack).find((trackId) =>
        versionsByTrack[trackId].some((v) => v.id === updated.id),
      );
      if (owner) {
        versionsByTrack[owner] = versionsByTrack[owner].map((v) =>
          v.id === updated.id ? updated : v,
        );
      }
      return { ...prev, versionsByTrack };
    });
  }, []);

  const handleDownloadVersion = useCallback(
    (versionId: string) => {
      setDownloadingVersionId(versionId);
      api
        .downloadVersion(versionId)
        .then(applyDownloadedVersion)
        .catch(() => {})
        .finally(() => setDownloadingVersionId(null));
    },
    [applyDownloadedVersion],
  );

  const [projectDownloadLabel, setProjectDownloadLabel] = useState<string | null>(null);

  const handleDownloadProject = useCallback(async () => {
    if (!projectDetail || projectDownloadLabel) return;
    const targets = projectDetail.tracks
      .map((t) => {
        const versions = projectDetail.versionsByTrack[t.id] ?? [];
        return versions.find((v) => v.id === t.defaultVersionId) ?? versions[0] ?? null;
      })
      .filter((v): v is Version => !!v && v.file.source === "dropbox");
    if (targets.length === 0) return;

    try {
      for (let i = 0; i < targets.length; i++) {
        setProjectDownloadLabel(`Downloading ${i + 1} of ${targets.length}…`);
        const updated = await api.downloadVersion(targets[i].id).catch(() => null);
        if (updated) applyDownloadedVersion(updated);
      }
    } finally {
      setProjectDownloadLabel(null);
    }
  }, [projectDetail, projectDownloadLabel, applyDownloadedVersion]);

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
    if (selectedPlaylistId) {
      return (
        <PlaylistView
          title={
            selectedPlaylistId === FAVORITES_PLAYLIST_ID
              ? "Favorites"
              : playlists.find((p) => p.id === selectedPlaylistId)?.name ?? "Playlist"
          }
          isFavoritesView={selectedPlaylistId === FAVORITES_PLAYLIST_ID}
          entries={playlistEntries}
          player={player}
          isFavorite={isFavorite}
          onToggleFavorite={handleToggleFavorite}
          onRemove={handleRemoveFromPlaylist}
          onRename={handleRenamePlaylist}
          onDelete={handleDeletePlaylist}
        />
      );
    }
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
        playlists={playlists}
        onAddToPlaylist={handleAddToPlaylist}
        onCreatePlaylistWithTrack={handleCreatePlaylistWithTrack}
        onDownloadVersion={handleDownloadVersion}
        downloadingVersionId={downloadingVersionId}
        onDownloadProject={handleDownloadProject}
        projectDownloadLabel={projectDownloadLabel}
      />
    );
  }, [
    selectedPlaylistId,
    playlistEntries,
    playlists,
    handleRemoveFromPlaylist,
    handleRenamePlaylist,
    handleDeletePlaylist,
    projectsLoaded,
    hasProjects,
    importBusy,
    handleOpenNewProjectModal,
    projectDetail,
    isFavorite,
    handleToggleFavorite,
    player,
    handleSwitchDefaultVersion,
    handleImportPaths,
    handleOpenEditProjectModal,
    handleAddProjectCover,
    handleAddTrackCover,
    handleShare,
    handleDownloadProject,
    projectDownloadLabel,
    handleAddToPlaylist,
    handleCreatePlaylistWithTrack,
    handleDownloadVersion,
    downloadingVersionId,
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
          onSelectPlaylist={handleSelectPlaylist}
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

      {showNewPlaylistModal ? (
        <NewPlaylistModal
          onClose={() => setShowNewPlaylistModal(false)}
          onSubmit={handleSubmitNewPlaylist}
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
          adaptiveAccentEnabled={adaptiveAccentEnabled}
          onToggleAdaptiveAccent={handleToggleAdaptiveAccent}
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
