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

/**
 * Per-torrent computations shared by the unified index (see torrentIndex.ts,
 * which owns the actual list-building/orchestration - this module only ever
 * computes one torrent's worth of state at a time and knows nothing about
 * the registry, Transmission's live list as a whole, or the library walk).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReseedPlan } from "./reseedMatch.js";
import { getDedupeOriginal } from "./dedupeState.js";
import { isPathWithin } from "./fileops.js";

export type StorageStatus = "deduped" | "duplicate" | "mixed" | "n/a";

export interface OrphanOriginal {
  dir: string;
  name: string;
  totalBytes: number;
}

/**
 * Byte-accurate on-disk percentage: sum(files[].bytesCompleted) /
 * sum(files[].length) across every file Transmission reports, regardless of
 * wanted/unwanted state. Deliberately NOT the same as Transmission's own
 * RPC `percentDone`, which only counts files it considers "wanted" - a
 * torrent with some/all files deselected can legitimately report 100% done
 * there while having zero of those bytes actually on disk, a real, known
 * Transmission RPC quirk, not a bug in this math. This is the number that
 * actually matters when deciding whether it's safe to remove a torrent's
 * data.
 */
export function computePercentComplete(files: { length: number; bytesCompleted: number }[]): number {
  const totalLength = files.reduce((sum, f) => sum + f.length, 0);
  if (totalLength === 0) return 0;
  const totalCompleted = files.reduce((sum, f) => sum + f.bytesCompleted, 0);
  return totalCompleted / totalLength;
}

/**
 * Compares each matched file's real on-disk bytes (at Transmission's own
 * downloadDir) against the library file reseedMatch.ts found for it, via
 * device+inode equality - the only reliable way to tell "this is the same
 * hardlinked file" from "this happens to be the same size" without hashing
 * file contents outright. A file that can't be stat'd (e.g. genuinely
 * missing from downloadDir - a separate, already-surfaced problem via the
 * percentComplete mismatch note) is conservatively treated as NOT deduped
 * rather than silently skipped, since claiming "deduped" is a safety-
 * relevant claim this app should never get wrong optimistically.
 */
export async function computeStorageStatus(plan: ReseedPlan, downloadDir: string): Promise<StorageStatus> {
  if (plan.matchedCount !== plan.files.length) return "n/a";

  let anyDeduped = false;
  let anyDuplicate = false;
  for (const file of plan.files) {
    if (!file.candidate) continue; // zero-length match - nothing physical to compare
    try {
      const [onDisk, library] = await Promise.all([stat(join(downloadDir, file.relativePath)), stat(file.candidate)]);
      if (onDisk.dev === library.dev && onDisk.ino === library.ino) {
        anyDeduped = true;
      } else {
        anyDuplicate = true;
      }
    } catch {
      anyDuplicate = true;
    }
  }
  if (anyDeduped && anyDuplicate) return "mixed";
  return anyDeduped ? "deduped" : "duplicate";
}

/**
 * Checks the *one* specific place a deduped torrent's original data would
 * still be sitting, if its "Delete original copy" step was never run or
 * failed (see dedupe.ts/reseedApi.ts's delete-original route) - never a
 * broad search across the downloads share, deliberately, so this can never
 * suggest deleting an unrelated same-size file.
 *
 * The base directory comes from dedupeState.ts's recorded original location
 * (captured by commitDedupe at the one moment it's knowable - Transmission
 * itself forgets a torrent's previous downloadDir the instant a dedupe
 * relocates it via torrent-set-location, so there's no live RPC query that
 * could recover it afterward). A real bug lived here before this comment:
 * this used to assume the app's static DOWNLOADS_PATH setting directly was
 * where a torrent's original files sat, which silently missed anything
 * whose actual Transmission download-dir was a subfolder of that (e.g.
 * DOWNLOADS_PATH=/downloads but Transmission's own downloadDir was really
 * /downloads/complete - a completely normal setup). No recorded entry
 * means no orphan to report - never falls back to guessing.
 *
 * `relativePath` already includes the torrent's own name as its first path
 * segment (the same convention every other reseed/dedupe path relies on),
 * so `join(record.dir, file.relativePath)` is exactly where each file would
 * live if it were still there. Only reports a candidate when EVERY matched
 * file is confirmed present at its exact expected byte size - a partial/
 * resized leftover is left alone rather than guessed at, same rigor this
 * app applies everywhere before an action that leads to a deletion.
 */
export async function findOrphanOriginal(
  plan: ReseedPlan,
  downloadsPath: string,
  dedupeStatePath: string
): Promise<OrphanOriginal | null> {
  const record = getDedupeOriginal(plan.torrentName, dedupeStatePath);
  if (!record) return null;
  // Defensive sanity check on recorded state, same "confine before trusting
  // a filesystem path" posture this app applies to client-supplied paths -
  // Transmission's own downloadDir is never client input, but it's still
  // worth confirming it actually is where we expect before treating it as
  // authoritative.
  if (!isPathWithin(record.dir, downloadsPath)) return null;

  let totalBytes = 0;
  for (const file of plan.files) {
    if (!file.candidate) continue; // zero-length match - nothing physical to confirm
    try {
      const info = await stat(join(record.dir, file.relativePath));
      if (info.size !== file.length) return null;
      totalBytes += file.length;
    } catch {
      return null;
    }
  }
  if (totalBytes === 0) return null; // nothing but zero-length entries - nothing to reclaim
  // record.name (captured at dedupe time), not plan.torrentName (Transmission's
  // current live name) - the on-disk file/folder's actual name reflects
  // whatever was true when it was downloaded, not any later rename.
  return { dir: record.dir, name: record.name, totalBytes };
}
