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

import { link, copyFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ReseedPlan } from "./reseedMatch.js";

export interface StageResult {
  relativePath: string;
  destPath: string;
  method: "hardlink" | "copy" | "empty";
}

/** Narrow dependency-injection seam - only exists so the EXDEV fallback path (unreproducible on a real single-filesystem CI box) can be exercised in a test. Every real caller omits this. */
export interface StageDeps {
  link?: typeof link;
  copyFile?: typeof copyFile;
  writeFile?: typeof writeFile;
}

function isExdev(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EXDEV";
}

/** Same DI reasoning as StageDeps above - a stuck-directory clearing failure isn't reproducibly forceable through a real filesystem in CI without this seam. Every real caller omits this. */
export interface PrepareStagingDirDeps {
  rm?: typeof rm;
  mkdir?: typeof mkdir;
  /** Test seam for the fallback suffix - real callers never pass this. */
  randomSuffix?: () => string;
}

/**
 * Clears `dir` (if anything's there) and recreates it fresh - the shared
 * first step before staging matched files (see commitReseed/commitDedupe).
 * Falls back to a fresh, uniquely-suffixed sibling directory rather than
 * throwing if the requested one can't be fully cleared - real incident: a
 * stuck `.fuse_hidden*` file (Unraid's shfs/FUSE layer renaming a file that
 * got deleted while still open by another process - almost always
 * Transmission itself, mid-read, from an earlier reverted dedupe attempt)
 * permanently blocked every future dedupe on that torrent with a bare
 * ENOTEMPTY, since nothing here can force another process to release a
 * file handle it's still holding. Returns whatever directory actually
 * ended up ready to use - callers must stage into THIS path, not
 * necessarily the one they asked for.
 */
export async function prepareStagingDir(dir: string, deps: PrepareStagingDirDeps = {}): Promise<string> {
  const doRm = deps.rm ?? rm;
  const doMkdir = deps.mkdir ?? mkdir;
  const suffix = deps.randomSuffix ?? (() => randomBytes(3).toString("hex"));
  try {
    await doRm(dir, { recursive: true, force: true });
    await doMkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    const fallback = `${dir}-${suffix()}`;
    console.warn(`[reseed-stage] "${dir}" wouldn't fully clear (${err}) - staging into "${fallback}" instead.`);
    await doMkdir(fallback, { recursive: true });
    return fallback;
  }
}

/**
 * Materializes every "matched" file in `plan` under `perTorrentDir`, in the
 * exact relative layout the torrent expects (each `relativePath` already
 * includes the torrent's own name as its first segment - see
 * torrentFile.ts). Hardlinked when possible (instant, zero extra disk - the
 * library file and the staged path are the literal same inode), falling
 * back to a real copy only on EXDEV (staging dir on a different filesystem/
 * device than the matched library file). Ambiguous/unmatched entries are
 * never created here - their absence is exactly what surfaces as a partial
 * verify in Transmission (see reseed.ts).
 */
export async function stageMatchedFiles(
  plan: ReseedPlan,
  perTorrentDir: string,
  deps: StageDeps = {}
): Promise<StageResult[]> {
  const doLink = deps.link ?? link;
  const doCopy = deps.copyFile ?? copyFile;
  const doWrite = deps.writeFile ?? writeFile;

  const results: StageResult[] = [];
  for (const file of plan.files) {
    if (file.status !== "matched") continue;

    const destPath = join(perTorrentDir, file.relativePath);
    await mkdir(dirname(destPath), { recursive: true });
    await rm(destPath, { force: true });

    if (!file.candidate) {
      // Zero-length match (see reseedMatch.ts) - nothing to link/copy from.
      await doWrite(destPath, Buffer.alloc(0));
      results.push({ relativePath: file.relativePath, destPath, method: "empty" });
      continue;
    }

    try {
      await doLink(file.candidate, destPath);
      results.push({ relativePath: file.relativePath, destPath, method: "hardlink" });
    } catch (err) {
      if (!isExdev(err)) throw err;
      await doCopy(file.candidate, destPath);
      results.push({ relativePath: file.relativePath, destPath, method: "copy" });
    }
  }
  return results;
}
