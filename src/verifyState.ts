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
const DEFAULT_VERIFY_STATE_PATH = join(__dirname, "..", "config", "verify-state.json");

export interface VerifyRecord {
  checkedAt: string;
  percentDone: number;
  clean: boolean;
}

// In-memory cache of whatever was last loaded from `path` below - same
// avoid-re-reading-every-call convention as dedupeState.ts/activity.ts,
// still surviving a container restart since a fresh process re-reads it
// once on first access.
let records: Record<string, VerifyRecord> = {};
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
    console.warn(`[verify-state] failed to read persisted verify-result map at "${path}", starting empty: ${err}`);
    records = {};
  }
}

function persist(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Best-effort, same as dedupeState.ts/activity.ts - never let a disk
    // hiccup here fail the verify request that triggered it.
    console.warn(`[verify-state] failed to persist verify-result map to "${path}": ${err}`);
  }
}

/**
 * Records the outcome of a forced Transmission piece-hash re-check (see
 * torrentVerify.ts's checkTorrentIntegrity) - keyed by info-hash, the same
 * stable identity torrentIndex.ts and torrentRegistry.ts already use
 * (unlike dedupeState.ts's own name-keying, a known quirk of that older
 * file - not repeated here). Called by reseedApi.ts's /api/reseed/verify
 * route after every check, clean or not, so the Index tab can show an
 * ongoing integrity signal rather than only a one-off action result.
 */
export function recordVerifyResult(
  infoHash: string,
  record: VerifyRecord,
  path: string = DEFAULT_VERIFY_STATE_PATH
): void {
  load(path);
  records[infoHash] = record;
  persist(path);
}

/**
 * Looks up the most recent verify result for a torrent, if any - null for
 * one that's never been through a forced Verify data check. Called by
 * torrentIndex.ts's buildTorrentIndex to enrich every entry.
 */
export function getVerifyResult(
  infoHash: string,
  path: string = DEFAULT_VERIFY_STATE_PATH
): VerifyRecord | null {
  load(path);
  return records[infoHash] ?? null;
}

export { DEFAULT_VERIFY_STATE_PATH };
