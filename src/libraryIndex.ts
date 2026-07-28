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

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Recursively walks `root`, bucketing every regular file's absolute path by
 * its exact byte size - the cheap first pass src/reseedMatch.ts builds on
 * to find candidate matches for a torrent's expected file sizes. Every
 * existing `readdir` call elsewhere in this codebase (fileops.ts,
 * hotfolder.ts, coverArt.ts) is single-level only, so this is written from
 * scratch rather than reused.
 *
 * Symlinks are never followed (skipped entirely, whether they point to a
 * file or a directory) - avoids symlink-cycle infinite loops and counting
 * one physical file under two different paths. `excludeDirs` lets callers
 * keep the reseed staging directory itself (which lives inside the library
 * root) out of its own candidate pool.
 */
export async function buildSizeIndex(
  root: string,
  opts: { excludeDirs?: string[] } = {}
): Promise<Map<number, string[]>> {
  const excluded = new Set((opts.excludeDirs ?? []).map((dir) => resolve(dir)));
  const index = new Map<number, string[]>();
  await walk(resolve(root), excluded, index);
  return index;
}

async function walk(dir: string, excluded: Set<string>, index: Map<number, string[]>): Promise<void> {
  if (excluded.has(dir)) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[library-index] failed to read directory "${dir}": ${err}`);
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, excluded, index);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(entryPath);
      const bucket = index.get(info.size);
      if (bucket) bucket.push(entryPath);
      else index.set(info.size, [entryPath]);
    } catch (err) {
      console.warn(`[library-index] failed to stat "${entryPath}": ${err}`);
    }
  }
}
