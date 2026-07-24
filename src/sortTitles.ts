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

import { join } from "node:path";
import type { ShowConfig, ShowsConfigFile } from "./config.js";
import { fetchShowRatingKeyIndex, lookupShowRatingKey, setShowSortTitle, type PlexConfig } from "./plex.js";

/**
 * "01 Tour Down Under" - a 2-digit zero-padded number (matches how the
 * user already hand-writes these in Plex today, e.g. "01" through
 * whatever the WorldTour calendar runs to, comfortably under 100) plus
 * the show's own folder name. Plex sorts shows by this string, not by the
 * displayed title, once it's locked - the number prefix is what actually
 * drives chronological ordering; the real name after it just keeps the
 * sort title readable in Plex's own UI.
 */
export function formatSortTitle(sortOrder: number, folderName: string): string {
  return `${String(sortOrder).padStart(2, "0")} ${folderName}`;
}

export interface SortTitleSyncResult {
  id: string;
  status: "synced" | "skipped" | "error";
  /** Set when status is "skipped" (e.g. Plex hasn't indexed this show yet) or "error". */
  reason?: string;
}

/**
 * Pushes a locked sort title to Plex for every show that has a
 * ShowConfig.sortOrder set, skipping (not erroring) shows Plex doesn't
 * know about yet - a show only gets a Plex ratingKey once at least one of
 * its episodes has been archived and scanned, so this is a normal,
 * expected outcome for a just-added event, not a failure. Fetches the
 * ratingKey index ONCE for the whole batch (see fetchShowRatingKeyIndex's
 * own doc comment for why per-show lookups don't scale) rather than once
 * per show.
 */
export async function syncSortTitlesToPlex(
  config: ShowsConfigFile,
  plex: PlexConfig,
  libraryRoot: string
): Promise<SortTitleSyncResult[]> {
  const shows = config.shows.filter((s): s is ShowConfig & { sortOrder: number } => typeof s.sortOrder === "number");
  const results: SortTitleSyncResult[] = [];
  if (shows.length === 0) return results;

  const index = await fetchShowRatingKeyIndex(plex);

  for (const show of shows) {
    const showRootFolder = join(libraryRoot, show.folderName);
    const ratingKey = lookupShowRatingKey(index, plex, libraryRoot, showRootFolder);
    if (!ratingKey) {
      results.push({ id: show.id, status: "skipped", reason: "not yet indexed by Plex - archive an episode first" });
      continue;
    }
    try {
      await setShowSortTitle(plex, ratingKey, formatSortTitle(show.sortOrder, show.folderName));
      results.push({ id: show.id, status: "synced" });
    } catch (err) {
      results.push({ id: show.id, status: "error", reason: String(err) });
    }
  }
  return results;
}
