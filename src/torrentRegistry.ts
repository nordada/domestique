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

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathWithin } from "./fileops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TORRENT_REGISTRY_DIR = join(__dirname, "..", "config", "torrent-registry");

const TORRENT_EXT = ".torrent";

export interface RegistryEntry {
  torrentName: string;
  sizeBytes: number;
  addedAt: string;
}

/**
 * Confines a torrent name to a safe filename within registryDir before any
 * filesystem touch. `torrentName` is already validated as a single, safe
 * path segment by torrentFile.ts's sanitizePathSegment during parsing (no
 * `/`, `\`, NUL, `..`) - this re-confirms it rather than trusting that
 * blindly, the same "confine before touching the filesystem" discipline
 * used everywhere else in this app (e.g. commitDedupe's staging-dir check).
 */
function safeRegistryPath(torrentName: string, registryDir: string): string {
  const path = join(registryDir, `${torrentName}${TORRENT_EXT}`);
  if (!isPathWithin(path, registryDir)) {
    throw new Error(`torrent name "${torrentName}" resolves outside the registry directory - refusing to touch it`);
  }
  return path;
}

/**
 * Saves a successfully-staged torrent's raw bytes for later download/
 * reference - see reseedApi.ts's /api/reseed/commit, which calls this
 * whenever a commit actually staged something (result.staged === true).
 * Overwrites any existing entry of the same name - re-committing the same
 * torrent just refreshes the saved copy, not an error.
 */
export async function registerTorrent(torrentName: string, buf: Buffer, registryDir: string): Promise<void> {
  await mkdir(registryDir, { recursive: true });
  await writeFile(safeRegistryPath(torrentName, registryDir), buf);
}

/**
 * Cheap existence check - no parsing, no library walk - used by the batch
 * queue's pre-check (see reseedApi.ts's /api/reseed/registry/check) to
 * skip an already-registered torrent before the expensive preview/commit
 * cycle that's the whole reason this module exists.
 */
export async function isRegistered(torrentName: string, registryDir: string): Promise<boolean> {
  try {
    await stat(safeRegistryPath(torrentName, registryDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists every registered torrent's name/size/added-date - deliberately
 * doesn't parse each .torrent's own contents (that's the caller's job; see
 * reseedApi.ts's /api/reseed/registry route, which needs the parsed
 * metadata anyway to cross-reference against the library). Returns an
 * empty list rather than throwing if the directory doesn't exist yet -
 * "nothing registered" is a normal first-use state, not an error.
 */
export async function listRegistry(registryDir: string): Promise<RegistryEntry[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(registryDir)).filter((name) => name.endsWith(TORRENT_EXT));
  } catch {
    return [];
  }
  return Promise.all(
    fileNames.map(async (fileName) => {
      const torrentName = fileName.slice(0, -TORRENT_EXT.length);
      const info = await stat(join(registryDir, fileName));
      return { torrentName, sizeBytes: info.size, addedAt: info.mtime.toISOString() };
    })
  );
}

/**
 * Reads a previously-registered torrent's raw bytes back - see
 * reseedApi.ts's /api/reseed/registry/download route. Returns null (not a
 * thrown error) when nothing's registered under this name, or the name
 * doesn't confine safely, so the route can 404/400 cleanly either way.
 */
export async function getRegisteredTorrentBuf(torrentName: string, registryDir: string): Promise<Buffer | null> {
  try {
    return await readFile(safeRegistryPath(torrentName, registryDir));
  } catch {
    return null;
  }
}
