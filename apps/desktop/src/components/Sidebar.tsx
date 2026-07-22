import type { Playlist, Project } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { HeartIcon, PlusIcon, SettingsIcon } from "./icons";
import { FAVORITES_PLAYLIST_ID } from "../lib/constants";
import "./Sidebar.css";

interface SidebarProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  playlists: Playlist[];
  selectedPlaylistId: string | null;
  onSelectPlaylist: (id: string) => void;
  onNewPlaylist: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  playlists,
  selectedPlaylistId,
  onSelectPlaylist,
  onNewPlaylist,
  onOpenSettings,
}: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="sidebar__sections">
        <div className="sidebar__section">
          <div className="sidebar__section-head">
            <span className="mono-label">Projects</span>
            <button className="sidebar__add" onClick={onNewProject} title="New project">
              <PlusIcon />
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="sidebar__empty">No projects yet</div>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                className={
                  "project-row" + (project.id === selectedProjectId ? " is-active" : "")
                }
                onClick={() => onSelectProject(project.id)}
              >
                <CoverThumb cover={project.coverImage} size={34} />
                <span className="project-row__name">{project.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar__section">
          <div className="sidebar__section-head">
            <span className="mono-label">Playlists</span>
            <button className="sidebar__add" onClick={onNewPlaylist} title="New playlist">
              <PlusIcon />
            </button>
          </div>
          <button
            className={
              "playlist-row playlist-row--favorites" +
              (selectedPlaylistId === FAVORITES_PLAYLIST_ID ? " is-active" : "")
            }
            onClick={() => onSelectPlaylist(FAVORITES_PLAYLIST_ID)}
          >
            <HeartIcon filled className="playlist-row__icon" />
            Favorites
          </button>
          {playlists.length === 0 ? null : (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                className={
                  "playlist-row" + (playlist.id === selectedPlaylistId ? " is-active" : "")
                }
                onClick={() => onSelectPlaylist(playlist.id)}
              >
                {playlist.name}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="sidebar__footer">
        <button className="sidebar__settings" onClick={onOpenSettings} title="Settings">
          <SettingsIcon />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
