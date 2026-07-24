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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSeeded } from "./fileseed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACTIVITY_PATH = join(__dirname, "..", "config", "activity.json");

export interface ActivityEvent {
  id: string;
  /** Whether the user has dismissed/acknowledged this entry - the front-page "Recent activity" list only shows unread events; the Settings-tab full log shows everything regardless. Never affects retention - "Clear" marks everything read rather than deleting history. */
  read: boolean;
  timestamp: string;
  torrentName: string;
  lines: string[];
  reviewWorthy: boolean;
}

const MAX_EVENTS = 100;

// In-memory cache of whatever was last loaded from `path` below - avoids
// re-reading the file on every single status poll, while still surviving a
// container restart (a fresh process re-reads it once on first access).
let events: ActivityEvent[] = [];
let loadedFrom: string | null = null;

function load(path: string): void {
  if (loadedFrom === path) return;
  loadedFrom = path;
  // Same bind-mount-creates-an-empty-directory gotcha as config/settings.json
  // (see fileseed.ts) applies here too, since this is bind-mounted the same
  // way for persistence across container recreation, not just restarts.
  ensureSeeded(path, () => "[]\n");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    events = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[activity] failed to read persisted activity log at "${path}", starting empty: ${err}`);
    events = [];
  }
}

function persist(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(events, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Activity logging is best-effort - never let a disk hiccup here fail
    // the torrent-done/webui request that triggered it.
    console.warn(`[activity] failed to persist activity log to "${path}": ${err}`);
  }
}

/**
 * Newest first. Capped at MAX_EVENTS, oldest evicted first. Persisted to
 * disk (see DEFAULT_ACTIVITY_PATH / ACTIVITY_PATH) so the log survives a
 * container restart - previously this was pure in-memory state and reset to
 * empty on every restart, which made the Activity tab look confusingly
 * sparse right after one (see the CA Appdata Backup/Restore incident this
 * came up in). `id`/`read` are assigned here rather than by each caller,
 * since every recordActivity call site just wants to log an event, not
 * think about read-tracking.
 */
export function recordActivity(
  event: Omit<ActivityEvent, "id" | "read">,
  path: string = DEFAULT_ACTIVITY_PATH
): void {
  load(path);
  events.unshift({ ...event, id: randomUUID(), read: false });
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  persist(path);
}

/**
 * Marks one or more events as read (dismissed from the front-page "Recent
 * activity" list) without deleting them - they still show up in the
 * Settings-tab full log. `ids: "all"` marks every currently-persisted event
 * read in one call (the "Clear" button's action) rather than requiring the
 * caller to enumerate every id itself.
 */
export function markActivityRead(ids: string[] | "all", path: string = DEFAULT_ACTIVITY_PATH): void {
  load(path);
  const idSet = ids === "all" ? null : new Set(ids);
  for (const event of events) {
    if (idSet === null || idSet.has(event.id)) {
      event.read = true;
    }
  }
  persist(path);
}

export function getRecentActivity(path: string = DEFAULT_ACTIVITY_PATH): ActivityEvent[] {
  load(path);
  return events;
}

export { DEFAULT_ACTIVITY_PATH };
