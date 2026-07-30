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

/**
 * Deliberately dumb byte storage - this module never parses a .torrent's
 * contents (no name, no file list). `infoHash` (see bencode.ts's
 * computeInfoHash / torrentFile.ts's TorrentMetainfo) is the one identity a
 * caller needs to provide, since it's what makes an entry here reliably
 * correlate with a live Transmission torrent by hash instead of by a name
 * that could collide or get renamed. See torrentIndex.ts for the layer that
 * actually re-parses each entry's saved bytes into something displayable.
 */
export interface RegistryFileEntry {
  infoHash: string;
  sizeBytes: number;
  addedAt: string;
}

/**
 * Confines an info-hash to a safe filename within registryDir before any
 * filesystem touch. In practice a lowercase-hex SHA1 digest can never
 * contain a path separator or NUL byte, so this can't actually be defeated
 * by a malformed hash - kept anyway as cheap defense-in-depth, the same
 * "confine before touching the filesystem" discipline used everywhere else
 * in this app (e.g. commitDedupe's staging-dir check).
 */
function safeRegistryPath(infoHash: string, registryDir: string): string {
  const path = join(registryDir, `${infoHash}${TORRENT_EXT}`);
  if (!isPathWithin(path, registryDir)) {
    throw new Error(`info-hash "${infoHash}" resolves outside the registry directory - refusing to touch it`);
  }
  return path;
}

/**
 * Saves a torrent's raw bytes for later download/reference, keyed by its
 * info-hash - see reseedApi.ts's /api/reseed/commit (a successful stage)
 * and transmissionTorrentSync.ts (autobrr-added torrents synced in from
 * Transmission's own torrents directory). Overwrites any existing entry
 * under the same hash - re-registering identical content just refreshes
 * the saved copy, not an error (and can't actually differ, since the hash
 * is derived from the content itself).
 */
export async function registerTorrent(infoHash: string, buf: Buffer, registryDir: string): Promise<void> {
  await mkdir(registryDir, { recursive: true });
  await writeFile(safeRegistryPath(infoHash, registryDir), buf);
}

/**
 * Cheap existence check - no parsing, no library walk - used by the batch
 * queue's pre-check (see reseedApi.ts's /api/reseed/index/check) to skip an
 * already-registered torrent before the expensive preview/commit cycle,
 * and by transmissionTorrentSync.ts to avoid re-copying something already
 * captured.
 */
export async function isRegistered(infoHash: string, registryDir: string): Promise<boolean> {
  try {
    await stat(safeRegistryPath(infoHash, registryDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists every registered torrent's hash/size/added-date - deliberately
 * doesn't parse each .torrent's own contents (that's torrentIndex.ts's job,
 * which needs the parsed metadata anyway to cross-reference against the
 * library and Transmission). Returns an empty list rather than throwing if
 * the directory doesn't exist yet - "nothing registered" is a normal
 * first-use state, not an error.
 */
export async function listRegistry(registryDir: string): Promise<RegistryFileEntry[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(registryDir)).filter((name) => name.endsWith(TORRENT_EXT));
  } catch {
    return [];
  }
  return Promise.all(
    fileNames.map(async (fileName) => {
      const infoHash = fileName.slice(0, -TORRENT_EXT.length);
      const info = await stat(join(registryDir, fileName));
      return { infoHash, sizeBytes: info.size, addedAt: info.mtime.toISOString() };
    })
  );
}

/**
 * Reads a previously-registered torrent's raw bytes back - see
 * reseedApi.ts's /api/reseed/index/download route. Returns null (not a
 * thrown error) when nothing's registered under this hash, or the hash
 * doesn't confine safely, so the route can 404/400 cleanly either way.
 */
export async function getRegisteredTorrentBuf(infoHash: string, registryDir: string): Promise<Buffer | null> {
  try {
    return await readFile(safeRegistryPath(infoHash, registryDir));
  } catch {
    return null;
  }
}
