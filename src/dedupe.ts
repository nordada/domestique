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

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildSizeIndex } from "./libraryIndex.js";
import { buildReseedPlan, type ReseedPlan } from "./reseedMatch.js";
import { stageMatchedFiles, prepareStagingDir, type StageResult } from "./reseedStage.js";
import { isPathWithin } from "./fileops.js";
import {
  getAllTorrentsWithFiles,
  setTorrentLocation,
  verifyTorrent,
  pollTorrentVerification,
  type TransmissionConfig,
  type TorrentVerifyResult,
} from "./transmission.js";

export interface TorrentOriginalLocation {
  dir: string;
  name: string;
}

export interface DedupeResult {
  staged: boolean;
  /** True if a dirty/partial verify triggered an automatic revert back to the torrent's pre-dedupe location - the torrent's data should be exactly as it was before this call, just re-verified once more to confirm. */
  reverted: boolean;
  plan: ReseedPlan;
  stagedFiles: StageResult[];
  perTorrentDir: string;
  /** Where Transmission had this torrent's data before this call - only meaningful once `staged` is true, since that's the one case where the caller needs it (to offer deleting the now-orphaned original download-folder copy). */
  originalLocation?: TorrentOriginalLocation;
  verify: TorrentVerifyResult | null;
}

function isCleanVerify(verify: TorrentVerifyResult | null): verify is TorrentVerifyResult {
  return verify !== null && !verify.error && verify.percentDone === 1;
}

/**
 * Converts an already-seeding, full-duplicate torrent (data copied the
 * normal way into both the downloads share and the Plex library - see
 * fileops.ts's copyIntoLibrary, which never hardlinks) into a deduped one:
 * hardlinks the matched library files into the same `.reseed-staging/
 * <torrentName>/` convention commitReseed uses, repoints Transmission at
 * that directory, and forces a real hash verify - never trusting this
 * app's own size-only matching alone, same philosophy as reseed.ts.
 *
 * Unlike commitReseed, there's no `.torrent` file to work from here (this
 * torrent arrived via autobrr, not a manual reseed upload), so this always
 * operates on an existing Transmission torrent id via `torrent-set-location`
 * rather than `torrent-add`. The torrent's name/files/location are always
 * re-fetched fresh from Transmission here, never trusted from a caller -
 * same rule the rest of reseedApi.ts's routes already follow.
 *
 * Refuses to touch the filesystem or Transmission at all unless every file
 * in the torrent matched unambiguously (`matchedCount === files.length`) -
 * a partial dedupe would relocate Transmission to a directory genuinely
 * missing some of the torrent's files. If the post-relocate verify doesn't
 * come back clean (error, or anything less than 100%), automatically
 * reverts Transmission's location back to where the torrent originally was
 * and re-verifies there too - a torrent that was seeding fine before this
 * call must never end up broken because of it, even on an unlucky
 * same-size/different-content collision (the exact class of mismatch this
 * app's own matching can't rule out - Transmission's hash verify is what
 * actually can).
 */
export async function commitDedupe(
  id: number,
  libraryRoot: string,
  stagingRoot: string,
  transmissionConfig: TransmissionConfig
): Promise<DedupeResult> {
  const torrents = await getAllTorrentsWithFiles(transmissionConfig);
  const torrent = torrents.find((t) => t.id === id);
  if (!torrent) {
    throw new Error(`Transmission doesn't report a torrent with id ${id}`);
  }

  const sizeIndex = await buildSizeIndex(libraryRoot, { excludeDirs: [stagingRoot] });
  const plan = buildReseedPlan(
    { name: torrent.name, files: torrent.files.map((f) => ({ relativePath: f.name, length: f.length })) },
    sizeIndex
  );

  if (plan.matchedCount !== plan.files.length) {
    return { staged: false, reverted: false, plan, stagedFiles: [], perTorrentDir: "", verify: null };
  }

  const requestedDir = join(stagingRoot, plan.torrentName);
  // plan.torrentName here is Transmission's own live torrent name, not one
  // that's been through torrentFile.ts's per-segment sanitization (that
  // only runs when parsing an uploaded .torrent, see reseed.ts) - confine
  // it the same way the webhook confines a client-supplied dir/name before
  // touching the filesystem, rather than trusting join() alone to be safe
  // against a malformed/adversarial name. Checked on the requested path -
  // prepareStagingDir's own fallback is always still within stagingRoot by
  // construction (an appended suffix, never a new ".." segment), so it
  // doesn't need re-checking.
  if (!isPathWithin(requestedDir, stagingRoot)) {
    throw new Error(`torrent name "${plan.torrentName}" resolves outside the staging directory - refusing to stage it`);
  }

  const originalLocation: TorrentOriginalLocation = { dir: torrent.downloadDir, name: torrent.name };

  const perTorrentDir = await prepareStagingDir(requestedDir);
  const stagedFiles = await stageMatchedFiles(plan, perTorrentDir);

  await setTorrentLocation(transmissionConfig, id, perTorrentDir);
  await verifyTorrent(transmissionConfig, id);
  const verify = await pollTorrentVerification(transmissionConfig, id);

  if (isCleanVerify(verify)) {
    return { staged: true, reverted: false, plan, stagedFiles, perTorrentDir, originalLocation, verify };
  }

  await setTorrentLocation(transmissionConfig, id, originalLocation.dir);
  await verifyTorrent(transmissionConfig, id);
  await pollTorrentVerification(transmissionConfig, id);

  // Best-effort - the revert itself has already succeeded regardless of
  // whether this cleanup does. Real incident this closes: a reverted
  // dedupe used to leave its staged hardlink behind indefinitely, which
  // could turn into a stuck `.fuse_hidden*` file (if Transmission hadn't
  // fully released it yet) that then permanently blocked every future
  // dedupe attempt on this same torrent with a bare ENOTEMPTY - see
  // prepareStagingDir's own fallback in reseedStage.ts for the other half
  // of this fix.
  await rm(perTorrentDir, { recursive: true, force: true }).catch((err) =>
    console.warn(`[dedupe] failed to clean up staging dir "${perTorrentDir}" after revert: ${err}`)
  );

  return { staged: false, reverted: true, plan, stagedFiles, perTorrentDir, originalLocation, verify };
}
