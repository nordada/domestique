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

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTorrentFile } from "./torrentFile.js";
import { registerTorrent, isRegistered } from "./torrentRegistry.js";

/**
 * autobrr (and anything else) hands a .torrent straight to Transmission,
 * never through Domestique - so Domestique's own registry would otherwise
 * only ever see torrents that happened to go through the Index tab's
 * Preview/Commit. Transmission itself keeps a permanent copy of every
 * .torrent it's ever been given in its own config directory (a `torrents`
 * subfolder next to its own settings.json/resume/ - see the README for how
 * to find it). Given read-only access to that directory, this copies
 * anything not already in Domestique's own registry into it, matched by
 * info-hash - Transmission's own filename convention for these files is
 * treated as opaque (never parsed for identity, since it can vary by
 * Transmission version); every file's bytes are re-parsed independently to
 * get its real info-hash, the same way any other .torrent entering the
 * registry does.
 *
 * A no-op returning 0 when `transmissionTorrentsDir` is null (feature not
 * configured). Best-effort otherwise: a missing/unreadable directory (mount
 * briefly unavailable, permissions) logs a warning and returns 0 rather
 * than failing whatever's calling this - this is a convenience sync, not
 * something a torrent-index load should ever hard-fail on. A single
 * unparseable file (shouldn't happen - Transmission wrote it - but stay
 * defensive) is skipped, not fatal to the rest of the sync.
 */
export async function syncFromTransmissionTorrentsDir(
  transmissionTorrentsDir: string | null,
  registryDir: string
): Promise<number> {
  if (!transmissionTorrentsDir) return 0;

  let fileNames: string[];
  try {
    fileNames = (await readdir(transmissionTorrentsDir)).filter((name) => name.endsWith(".torrent"));
  } catch (err) {
    console.warn(`[transmission-torrent-sync] failed to read ${transmissionTorrentsDir}: ${err}`);
    return 0;
  }

  let syncedCount = 0;
  for (const fileName of fileNames) {
    try {
      const buf = await readFile(join(transmissionTorrentsDir, fileName));
      const meta = parseTorrentFile(buf);
      if (await isRegistered(meta.infoHash, registryDir)) continue;
      await registerTorrent(meta.infoHash, buf, registryDir);
      syncedCount++;
    } catch (err) {
      console.warn(`[transmission-torrent-sync] skipping "${fileName}": ${err}`);
    }
  }
  return syncedCount;
}
