/** Sentinel id for the pinned, always-first "Favorites" pseudo-playlist — not a
 *  real row in the `playlists` table, computed instead from the favorites list
 *  (see `api.listFavoriteTracks`). Recognized by App.tsx's selection routing. */
export const FAVORITES_PLAYLIST_ID = "__favorites__";
