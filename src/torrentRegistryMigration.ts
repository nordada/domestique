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

import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseTorrentFile } from "./torrentFile.js";

const TORRENT_EXT = ".torrent";
const HASH_SHAPE_RE = /^[0-9a-f]{40}$/;

/**
 * One-time cleanup for registry entries saved under the OLD name-keyed
 * scheme, from before this app's registry became hash-keyed - a real,
 * disclosed production incident, not a hypothetical: the name-keyed
 * registry genuinely shipped and was deployed before the hash-keyed
 * redesign, so real torrents accumulated under `<name>.torrent` filenames.
 * Once the hash-keyed redesign later deployed and its autobrr-capture sync
 * (transmissionTorrentSync.ts) ran against Transmission's own torrents
 * directory, it correctly registered that SAME content again under its
 * real `<hash>.torrent` filename too, since `isRegistered()` only ever
 * checks by hash - it has no way to recognize a legacy name-keyed file as
 * "the same torrent already registered." Left unmigrated, both files sit
 * side by side, both parse to identical content, and both independently
 * correlate to the same live Transmission torrent - inflating the Index's
 * counts (first surfaced as a real "904 in Transmission" vs. Transmission's
 * own reported 634 discrepancy, confirmed via Transmission's own
 * session-stats RPC as ground truth).
 *
 * Detects any `.torrent` filename that ISN'T a 40-character lowercase hex
 * hash, re-parses it for its real hash, and either renames it into place
 * (nothing registered under that real hash yet - a genuine migration, no
 * content lost) or deletes it outright (a correctly hash-keyed copy of the
 * identical content already exists - the legacy file is now pure
 * redundant duplication, safe to remove). Safe to run on every index load
 * - a no-op once every legacy entry has been migrated away, and each
 * individual file's own failure (e.g. one that no longer parses cleanly)
 * is logged and skipped rather than aborting the whole pass.
 */
export async function migrateLegacyRegistryEntries(
  registryDir: string
): Promise<{ migrated: number; removed: number }> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(registryDir)).filter((name) => name.endsWith(TORRENT_EXT));
  } catch {
    return { migrated: 0, removed: 0 };
  }

  let migrated = 0;
  let removed = 0;
  for (const fileName of fileNames) {
    const stem = fileName.slice(0, -TORRENT_EXT.length);
    if (HASH_SHAPE_RE.test(stem)) continue; // already correctly hash-keyed

    const legacyPath = join(registryDir, fileName);
    try {
      const buf = await readFile(legacyPath);
      const { infoHash } = parseTorrentFile(buf);
      const targetPath = join(registryDir, `${infoHash}${TORRENT_EXT}`);

      let targetExists = true;
      try {
        await stat(targetPath);
      } catch {
        targetExists = false;
      }

      if (targetExists) {
        await rm(legacyPath);
        removed++;
      } else {
        await rename(legacyPath, targetPath);
        migrated++;
      }
    } catch (err) {
      console.warn(`[torrent-registry-migration] failed to migrate "${fileName}": ${err}`);
    }
  }
  return { migrated, removed };
}
