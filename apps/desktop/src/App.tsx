import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CoverStyle, Playlist, Project } from "@session/shared-types";
import { api, type ProjectDetail } from "./lib/api";
import { usePlayer } from "./hooks/usePlayer";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { MainPanel } from "./components/MainPanel";
import { PlayerBar } from "./components/PlayerBar";
import { EmptyState } from "./components/EmptyState";
import "./App.css";

const AUDIO_EXTENSIONS = ["mp3", "wav", "aiff", "flac", "m4a", "aac"];

function favoriteKey(trackId: string, versionId?: string) {
  return `${trackId}::${versionId ?? "_"}`;
}

function nameFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
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

  const player = usePlayer();

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

  const runImportFlow = useCallback(async (existingProjectId?: string) => {
    setImportBusy(true);
    try {
      const selection = await open({
        multiple: true,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
      });
      const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];
      if (paths.length === 0) return;

      let projectId = existingProjectId;
      if (!projectId) {
        const project = await api.createProject(nameFromPath(paths[0]), "single");
        setProjects((prev) => [...prev, project]);
        projectId = project.id;
      }

      await api.importLocalFiles(projectId, paths);
      setSelectedProjectId(projectId);
      const detail = await api.getProjectDetail(projectId);
      setProjectDetail(detail);
    } catch {
      /* user cancelled the dialog, or the backend isn't ready yet */
    } finally {
      setImportBusy(false);
    }
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

  const hasProjects = projects.length > 0;

  const mainContent = useMemo(() => {
    if (!projectsLoaded) return null;
    if (!hasProjects) {
      return <EmptyState onImport={() => runImportFlow()} busy={importBusy} />;
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
      />
    );
  }, [
    projectsLoaded,
    hasProjects,
    importBusy,
    runImportFlow,
    projectDetail,
    handleChangeCoverStyle,
    isFavorite,
    handleToggleFavorite,
    player,
  ]);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          onNewProject={() => runImportFlow()}
          playlists={playlists}
          selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={setSelectedPlaylistId}
          onNewPlaylist={handleNewPlaylist}
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
    </div>
  );
}

export default App;
