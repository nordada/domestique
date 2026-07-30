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
const DEFAULT_MATCH_OVERRIDES_PATH = join(__dirname, "..", "config", "match-overrides.json");

/** relativePath -> the library candidate a human picked for it, see reseedMatch.ts's applyManualOverrides. */
type TorrentOverrides = Record<string, string>;

// In-memory cache of whatever was last loaded from `path` below - same
// avoid-re-reading-every-call convention as dedupeState.ts/verifyState.ts,
// still surviving a container restart since a fresh process re-reads it
// once on first access.
let records: Record<string, TorrentOverrides> = {};
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
    console.warn(`[match-overrides] failed to read persisted override map at "${path}", starting empty: ${err}`);
    records = {};
  }
}

function persist(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Best-effort, same as dedupeState.ts/verifyState.ts - never let a disk
    // hiccup here fail the resolve request that triggered it.
    console.warn(`[match-overrides] failed to persist override map to "${path}": ${err}`);
  }
}

/**
 * Records a human's own pick for one ambiguous file of one torrent - keyed
 * by info-hash (same stable identity torrentIndex.ts/verifyState.ts already
 * use, lowercased so Transmission's own mixed-case hashString and a parsed
 * .torrent's always-lowercase infoHash correlate to the same entry) and,
 * within that, by the file's own relativePath. Called by reseedApi.ts's
 * /api/reseed/index/resolve route only after re-validating the candidate
 * against a freshly-built plan - this module itself trusts whatever it's
 * given.
 */
export function recordManualMatch(
  infoHash: string,
  relativePath: string,
  candidate: string,
  path: string = DEFAULT_MATCH_OVERRIDES_PATH
): void {
  load(path);
  const key = infoHash.toLowerCase();
  records[key] = { ...records[key], [relativePath]: candidate };
  persist(path);
}

/**
 * Looks up every recorded manual pick for a torrent, if any - an empty
 * object for one with no overrides recorded at all. Called by
 * torrentIndex.ts/reseed.ts/dedupe.ts to feed reseedMatch.ts's
 * applyManualOverrides after building a fresh plan.
 */
export function getManualMatches(infoHash: string, path: string = DEFAULT_MATCH_OVERRIDES_PATH): TorrentOverrides {
  load(path);
  return records[infoHash.toLowerCase()] ?? {};
}

/**
 * Clears one file's recorded pick (the "undo" for a manual resolve gone
 * wrong) - called by reseedApi.ts's /api/reseed/index/resolve/clear route.
 * A no-op, not an error, if nothing was recorded for it.
 */
export function clearManualMatch(
  infoHash: string,
  relativePath: string,
  path: string = DEFAULT_MATCH_OVERRIDES_PATH
): void {
  load(path);
  const key = infoHash.toLowerCase();
  if (!records[key]) return;
  delete records[key][relativePath];
  if (Object.keys(records[key]).length === 0) delete records[key];
  persist(path);
}

export { DEFAULT_MATCH_OVERRIDES_PATH };
