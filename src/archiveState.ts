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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSeeded } from "./fileseed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARCHIVE_STATE_PATH = join(__dirname, "..", "config", "archive-state.json");

export interface ArchiveRecord {
  archivedAt: string;
}

// In-memory cache of whatever was last loaded from `path` below - same
// avoid-re-reading-every-call convention as verifyState.ts/dedupeState.ts,
// still surviving a container restart since a fresh process re-reads it
// once on first access.
let records: Record<string, ArchiveRecord> = {};
let loadedFrom: string | null = null;

function load(path: string): void {
  if (loadedFrom === path) return;
  loadedFrom = path;
  // Same bind-mount-creates-an-empty-directory gotcha as config/settings.json
  // and config/dedupe-state.json (see fileseed.ts) - this is bind-mounted the
  // same way for persistence across container recreation.
  ensureSeeded(path, () => "{}\n");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    records = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn(`[archive-state] failed to read persisted archive map at "${path}", starting empty: ${err}`);
    records = {};
  }
}

function persist(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Best-effort, same as verifyState.ts/dedupeState.ts - never let a disk
    // hiccup here fail the archive request that triggered it.
    console.warn(`[archive-state] failed to persist archive map to "${path}": ${err}`);
  }
}

/**
 * Marks a registered torrent as archived - keyed by info-hash, the same
 * stable identity torrentIndex.ts/verifyState.ts already use. Called by
 * reseedApi.ts's /api/reseed/archive route, after (best-effort) removing it
 * from Transmission without touching its downloaded data. Never touches the
 * torrent-registry entry or the library - archiving only ever hides an
 * entry from the Index tab's main list (see torrentIndex.ts's filter), it
 * doesn't delete anything, which is the whole point versus "Remove from
 * Transmission."
 */
export function recordArchived(
  infoHash: string,
  record: ArchiveRecord,
  path: string = DEFAULT_ARCHIVE_STATE_PATH
): void {
  load(path);
  records[infoHash.toLowerCase()] = record;
  persist(path);
}

/**
 * Looks up whether a torrent is currently archived - used by
 * torrentIndex.ts to exclude it from the main Index list.
 */
export function isArchived(infoHash: string, path: string = DEFAULT_ARCHIVE_STATE_PATH): boolean {
  load(path);
  return infoHash.toLowerCase() in records;
}

/**
 * Un-archives a torrent (the Settings tab's "Unarchive" action) - a no-op,
 * not an error, if nothing was recorded for it. Nothing else needs undoing:
 * archiving never removed the torrent-registry entry or touched the
 * library, so the torrent just reappears in the Index list on the next
 * buildTorrentIndex call, exactly as it would if it had never been
 * archived (still not back in Transmission if archiving removed it from
 * there - that's a separate "Re-add to Transmission" action).
 */
export function clearArchived(infoHash: string, path: string = DEFAULT_ARCHIVE_STATE_PATH): void {
  load(path);
  const key = infoHash.toLowerCase();
  if (!(key in records)) return;
  delete records[key];
  persist(path);
}

/**
 * Every currently-archived info-hash and when it was archived - backs the
 * Settings tab's "Archived torrents" list (see reseedApi.ts's
 * /api/reseed/index/archived route).
 */
export function listArchived(path: string = DEFAULT_ARCHIVE_STATE_PATH): Record<string, ArchiveRecord> {
  load(path);
  return records;
}

export { DEFAULT_ARCHIVE_STATE_PATH };
