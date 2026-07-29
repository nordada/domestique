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
const DEFAULT_DEDUPE_STATE_PATH = join(__dirname, "..", "config", "dedupe-state.json");

export interface DedupeOriginalRecord {
  dir: string;
  name: string;
}

// In-memory cache of whatever was last loaded from `path` below - same
// avoid-re-reading-every-call convention as activity.ts, still surviving a
// container restart since a fresh process re-reads it once on first access.
let records: Record<string, DedupeOriginalRecord> = {};
let loadedFrom: string | null = null;

function load(path: string): void {
  if (loadedFrom === path) return;
  loadedFrom = path;
  // Same bind-mount-creates-an-empty-directory gotcha as config/settings.json
  // and config/activity.json (see fileseed.ts) - this is bind-mounted the
  // same way for persistence across container recreation.
  ensureSeeded(path, () => "{}\n");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    records = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn(`[dedupe-state] failed to read persisted original-location map at "${path}", starting empty: ${err}`);
    records = {};
  }
}

function persist(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Best-effort, same as activity.ts - never let a disk hiccup here fail
    // the dedupe/delete request that triggered it.
    console.warn(`[dedupe-state] failed to persist original-location map to "${path}": ${err}`);
  }
}

/**
 * Records where a torrent's data lived just before a successful dedupe
 * relinked it (see dedupe.ts's commitDedupe, which captures this from
 * Transmission's own live downloadDir at exactly the right moment - the one
 * time it's still knowable at all, since Transmission itself forgets a
 * torrent's previous location the instant torrent-set-location moves it).
 * Keyed by torrent name, the same identifier the reseed staging directory
 * itself is already keyed by. Called by reseedApi.ts's /api/reseed/dedupe
 * route on a successful commit.
 */
export function recordDedupeOriginal(
  torrentName: string,
  original: DedupeOriginalRecord,
  path: string = DEFAULT_DEDUPE_STATE_PATH
): void {
  load(path);
  records[torrentName] = original;
  persist(path);
}

/**
 * Looks up a previously-recorded original location, if any - undefined for
 * a torrent that's never been deduped through this app (including one
 * that's already a hardlink from ingestion-time hardlink mode - there's
 * genuinely nothing to have recorded, since no duplicate ever existed), or
 * whose recorded entry has already been cleared (see clearDedupeOriginal).
 * Called by seeding.ts's findOrphanOriginal instead of assuming any
 * particular downloads-share layout.
 */
export function getDedupeOriginal(
  torrentName: string,
  path: string = DEFAULT_DEDUPE_STATE_PATH
): DedupeOriginalRecord | undefined {
  load(path);
  return records[torrentName];
}

/**
 * Clears a recorded original once its file has actually been deleted (see
 * reseedApi.ts's /api/reseed/delete-original route) - a stale leftover
 * entry would otherwise keep pointing orphan-detection at a location
 * that's genuinely gone, or worse, at a completely different future
 * torrent that happens to reuse the same name.
 */
export function clearDedupeOriginal(torrentName: string, path: string = DEFAULT_DEDUPE_STATE_PATH): void {
  load(path);
  delete records[torrentName];
  persist(path);
}

export { DEFAULT_DEDUPE_STATE_PATH };
