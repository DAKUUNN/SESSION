import { useMemo, useState } from "react";
import type { PlaylistTrackEntry } from "@session/shared-types";
import { CoverThumb } from "./CoverThumb";
import { CloseIcon, EditIcon, HeartIcon, PauseIcon, PlayIcon, ShuffleIcon } from "./icons";
import { formatDuration } from "../lib/format";
import type { PlayerApi } from "../hooks/usePlayer";
import "./PlaylistView.css";

interface PlaylistViewProps {
  title: string;
  /** The pinned Favorites pseudo-playlist can't be renamed or deleted, and its
   *  rows unfavorite (rather than remove-from-playlist) on the X button. */
  isFavoritesView: boolean;
  entries: PlaylistTrackEntry[];
  player: PlayerApi;
  isFavorite: (trackId: string, versionId?: string) => boolean;
  onToggleFavorite: (trackId: string, versionId?: string) => void;
  onRemove: (trackId: string, versionId?: string) => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
}

export function PlaylistView({
  title,
  isFavoritesView,
  entries,
  player,
  isFavorite,
  onToggleFavorite,
  onRemove,
  onRename,
  onDelete,
}: PlaylistViewProps) {
  const { nowPlaying, status, loadAndPlay, togglePlay } = player;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(title);

  const totalDuration = useMemo(
    () => entries.reduce((sum, e) => sum + (e.version?.durationSeconds ?? 0), 0),
    [entries],
  );

  const playableEntries = entries.filter((e) => e.version);
  const isThisPlaylistCurrent =
    !!nowPlaying && playableEntries.some((e) => e.version!.id === nowPlaying.versionId);

  function activate(entry: PlaylistTrackEntry) {
    if (!entry.version) return;
    loadAndPlay(
      {
        trackId: entry.track.id,
        versionId: entry.version.id,
        title: entry.track.title,
        versionLabel: entry.version.label,
        cover: entry.track.coverImage ?? entry.projectCover,
      },
      entry.version.file.path,
    );
  }

  function handleHeroPlay() {
    if (isThisPlaylistCurrent) {
      togglePlay();
      return;
    }
    const first = playableEntries[0];
    if (first) activate(first);
  }

  function handleShuffle() {
    if (playableEntries.length === 0) return;
    const pick = playableEntries[Math.floor(Math.random() * playableEntries.length)];
    activate(pick);
  }

  return (
    <section className="main-panel">
      <div className="main-panel__scroll">
        <div className="simple-header playlist-view__header">
          <div className="simple-header__title-row">
            {editingName ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = nameDraft.trim();
                  if (trimmed) onRename?.(trimmed);
                  setEditingName(false);
                }}
              >
                <input
                  className="text-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => setEditingName(false)}
                  autoFocus
                />
              </form>
            ) : (
              <div className="simple-header__title">
                {isFavoritesView ? <HeartIcon filled className="playlist-view__title-icon" /> : null}
                {title}
              </div>
            )}
            {!isFavoritesView && !editingName ? (
              <button
                className="icon-btn simple-header__edit-btn"
                onClick={() => {
                  setNameDraft(title);
                  setEditingName(true);
                }}
                title="Rename playlist"
              >
                <EditIcon />
              </button>
            ) : null}
            {!isFavoritesView ? (
              <button className="icon-btn simple-header__edit-btn" onClick={onDelete} title="Delete playlist">
                <CloseIcon />
              </button>
            ) : null}
          </div>
          <div className="simple-header__count">
            {entries.length} track{entries.length === 1 ? "" : "s"}, {formatDuration(totalDuration)}
          </div>
          {playableEntries.length > 0 ? (
            <div className="hero__actions playlist-view__actions">
              <button className="hero__play" onClick={handleHeroPlay} title="Play">
                {isThisPlaylistCurrent && status.isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button className="icon-btn hero__icon-btn" onClick={handleShuffle} title="Shuffle">
                <ShuffleIcon />
              </button>
            </div>
          ) : null}
        </div>

        <div className="tracklist">
          {entries.length === 0 ? (
            <div className="tracklist__empty">
              {isFavoritesView
                ? "Heart a track anywhere in Session to see it here."
                : "Add tracks to this playlist from any project."}
            </div>
          ) : (
            entries.map((entry, i) => {
              const isActive = !!entry.version && nowPlaying?.versionId === entry.version.id;
              const cover = entry.track.coverImage ?? entry.projectCover;
              return (
                <div
                  key={`${entry.track.id}::${entry.version?.id ?? "_"}::${i}`}
                  className={"track-row" + (isActive ? " is-active" : "")}
                  role="button"
                  tabIndex={0}
                  onClick={() => activate(entry)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate(entry);
                    }
                  }}
                >
                  <div className={"track-leading track-leading--cover" + (isActive ? " is-active" : "")}>
                    <CoverThumb cover={cover} size={34} />
                    <span className="track-leading__overlay">
                      {isActive && status.isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </span>
                  </div>

                  <div className="track-row__main">
                    <span className="track-row__title">{entry.track.title}</span>
                    <span className="playlist-view__project-name">{entry.projectName}</span>
                    {entry.version ? (
                      <span className="version-chip">{entry.version.label.toUpperCase()}</span>
                    ) : null}
                  </div>

                  <span className="track-row__duration">
                    {entry.version ? formatDuration(entry.version.durationSeconds) : "--:--"}
                  </span>

                  <button
                    className="favorite-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(entry.track.id, entry.version?.id);
                    }}
                    title={isFavoritesView ? "Remove from favorites" : "Remove from playlist"}
                  >
                    <CloseIcon />
                  </button>

                  {!isFavoritesView ? (
                    <button
                      className={
                        "favorite-btn" + (isFavorite(entry.track.id, entry.version?.id) ? " is-favorite" : "")
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(entry.track.id, entry.version?.id);
                      }}
                      title="Toggle favorite"
                    >
                      <HeartIcon filled={isFavorite(entry.track.id, entry.version?.id)} />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
