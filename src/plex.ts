/**
 * Domestique - files completed bike-race torrent downloads into a Plex-friendly library layout.
 * Copyright (C) 2026  @nordada AKA Chris Reynolds
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

export interface PlexConfig {
  url: string;
  token: string;
  sectionId: string;
  /**
   * The Plex library root, as Plex's OWN process/container sees it - this
   * can differ from this app's own LIBRARY_ROOT the same way Transmission's
   * downloads path did (see docker-compose.yml). Falls back to LIBRARY_ROOT
   * itself when PLEX_LIBRARY_ROOT isn't set, i.e. assumes identical paths.
   */
  libraryRoot: string;
}

export function plexConfigFromEnv(libraryRoot: string): PlexConfig | null {
  const url = process.env.PLEX_URL;
  const token = process.env.PLEX_TOKEN;
  const sectionId = process.env.PLEX_SECTION_ID;
  if (!url || !token || !sectionId) return null;

  return {
    url: url.replace(/\/$/, ""),
    token,
    sectionId,
    libraryRoot: process.env.PLEX_LIBRARY_ROOT || libraryRoot,
  };
}

export interface PlexIdentity {
  live: boolean;
  /** This server's own Plex machineIdentifier, needed to build a direct link to a library section (see plexLibraryUrl) - only available while Plex is actually reachable, since there's nowhere else to read it from. */
  machineIdentifier: string | null;
}

/**
 * Cheap liveness probe - hits Plex's own identity endpoint rather than the
 * section refresh route, so it doesn't touch the library. Also doubles as
 * how the header gauge's "open this library in Plex Web" link gets its
 * machineIdentifier, since /identity is the only place that's exposed.
 */
export async function checkPlexLive(plex: PlexConfig, timeoutMs = 3000): Promise<PlexIdentity> {
  try {
    const url = new URL(`${plex.url}/identity`);
    url.searchParams.set("X-Plex-Token", plex.token);
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[plex] ${plex.url}/identity responded ${res.status} ${res.statusText}`);
      return { live: false, machineIdentifier: null };
    }
    const data = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    return { live: true, machineIdentifier: data.MediaContainer?.machineIdentifier ?? null };
  } catch (err) {
    console.warn(`[plex] failed to reach ${plex.url}/identity: ${err}`);
    return { live: false, machineIdentifier: null };
  }
}

/** The local-network Plex Web URL that jumps straight to one library section, rather than just Plex's home screen. */
export function plexLibraryUrl(plex: PlexConfig, machineIdentifier: string): string {
  return `${plex.url}/web/index.html#!/media/${machineIdentifier}/com.plexapp.plugins.library?source=${plex.sectionId}`;
}

function translatePath(localPath: string, from: string, to: string): string {
  if (from === to || !localPath.startsWith(from)) return localPath;
  return to + localPath.slice(from.length);
}

/**
 * Triggers a partial Plex library scan limited to a single folder (e.g. a
 * season folder) via Plex's `/library/sections/{id}/refresh?path=...`
 * endpoint - much faster than a full section scan, and touches only the
 * one Plex library this section id points at, not any other library.
 *
 * localPath is the folder as THIS container sees it (i.e. under
 * LIBRARY_ROOT); it's translated to how Plex's own process sees the same
 * folder (PLEX_LIBRARY_ROOT) before calling out.
 */
export async function refreshPlexFolder(
  plex: PlexConfig,
  libraryRoot: string,
  localPath: string
): Promise<void> {
  const plexPath = translatePath(localPath, libraryRoot, plex.libraryRoot);

  const url = new URL(`${plex.url}/library/sections/${plex.sectionId}/refresh`);
  url.searchParams.set("path", plexPath);
  url.searchParams.set("X-Plex-Token", plex.token);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Plex refresh returned ${res.status} ${res.statusText}`);
  }
}

interface PlexShowMetadata {
  ratingKey?: string;
  Location?: Array<{ path?: string }>;
}

/**
 * Finds a show's Plex ratingKey by matching its root folder location
 * against every show in the configured library section. Needed because a
 * passive path-scoped scan (refreshPlexFolder) reliably detects new
 * episode files but does NOT reliably re-examine local media assets (like
 * a newly added poster.jpg) for a show Plex already considers fully
 * matched - confirmed via a real test where "Scan Library" left a fresh
 * poster invisible in Plex's poster picker, while Plex's own per-item
 * "Refresh Metadata" picked it up immediately. forceRefreshItem below is
 * the equivalent of that "Refresh Metadata" action, and needs this
 * ratingKey lookup first since Domestique only knows the show by its local
 * folder path, not Plex's internal id for it. Returns null (not a thrown
 * error) if no show's Location matches - e.g. Plex hasn't indexed this
 * show at all yet - so the caller can fall back to the passive refresh.
 */
export async function findShowRatingKey(
  plex: PlexConfig,
  libraryRoot: string,
  localFolder: string
): Promise<string | null> {
  const plexPath = translatePath(localFolder, libraryRoot, plex.libraryRoot);

  const url = new URL(`${plex.url}/library/sections/${plex.sectionId}/all`);
  url.searchParams.set("type", "2"); // shows
  url.searchParams.set("X-Plex-Token", plex.token);

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Plex section listing returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { MediaContainer?: { Metadata?: PlexShowMetadata[] } };
  const items = data.MediaContainer?.Metadata ?? [];
  const match = items.find((item) => item.Location?.some((loc) => loc.path === plexPath));
  return match?.ratingKey ?? null;
}

/**
 * Forces Plex to re-run its full agent chain (including Local Media
 * Assets) against one already-known item - the API equivalent of Plex's
 * own "Refresh Metadata" context-menu action, and the mechanism that
 * actually picks up a newly-added local poster for a show Plex already
 * considers complete.
 */
export async function forceRefreshItem(plex: PlexConfig, ratingKey: string): Promise<void> {
  const url = new URL(`${plex.url}/library/metadata/${ratingKey}/refresh`);
  url.searchParams.set("X-Plex-Token", plex.token);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Plex item refresh returned ${res.status} ${res.statusText}`);
  }
}
