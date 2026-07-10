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
