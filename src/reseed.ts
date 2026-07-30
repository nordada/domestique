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

import { join } from "node:path";
import { parseTorrentFile } from "./torrentFile.js";
import { buildSizeIndex } from "./libraryIndex.js";
import { buildReseedPlan, applyManualOverrides, type ReseedPlan } from "./reseedMatch.js";
import { getManualMatches } from "./matchOverrides.js";
import { stageMatchedFiles, prepareStagingDir, type StageResult } from "./reseedStage.js";
import {
  addTorrentToTransmission,
  pollTorrentVerification,
  startTorrent,
  type TransmissionConfig,
  type AddedTorrent,
  type TorrentVerifyResult,
} from "./transmission.js";

/** Hidden-dot convention, same as upload.ts's ".uploads-tmp" / fileops.ts's ".archiver-meta.json" - invisible to Plex, lives inside LIBRARY_ROOT by default (see settings.ts's resolveReseedStagingRoot) so hardlinking actually works (same filesystem/device as the library). */
export const DEFAULT_RESEED_STAGING_SUBDIR = ".reseed-staging";

/**
 * Pure library query: parses the .torrent, walks the library (excluding the
 * staging directory itself, so a previous commit's staged hardlinks never
 * get "discovered" as candidates for themselves), and matches - then layers
 * on any manual pick a human previously recorded for this exact torrent
 * (see matchOverrides.ts/reseedApi.ts's /api/reseed/index/resolve route),
 * keyed by the torrent's own infoHash so a pick made from the Index tab
 * still applies here even though this call never touched the registry.
 * Never writes anything, never touches Transmission - safe to call as often
 * as wanted.
 */
export async function previewReseed(
  torrentBuf: Buffer,
  libraryRoot: string,
  stagingRoot: string,
  overridesPath?: string
): Promise<ReseedPlan> {
  const meta = parseTorrentFile(torrentBuf);
  const sizeIndex = await buildSizeIndex(libraryRoot, { excludeDirs: [stagingRoot] });
  const plan = buildReseedPlan(meta, sizeIndex);
  return applyManualOverrides(plan, getManualMatches(meta.infoHash, overridesPath));
}

export interface ReseedCommitResult extends ReseedPlan {
  staged: boolean;
  stagedFiles: StageResult[];
  perTorrentDir: string;
  transmission?: { added: AddedTorrent; verify: TorrentVerifyResult | null; started: boolean };
}

function isCleanVerify(verify: TorrentVerifyResult | null): verify is TorrentVerifyResult {
  return verify !== null && !verify.error && verify.percentDone === 1;
}

/**
 * Re-derives a fresh plan (no caching between a prior Preview call and this
 * one - see the README's known limitations - a `.torrent` is cheap to
 * re-parse, and re-checking the library right before staging is more
 * correct anyway: it catches a library change made between the two calls).
 * Refuses to touch the filesystem or Transmission at all when nothing
 * matched. Otherwise clears/recreates this torrent's own staging subdir via
 * prepareStagingDir (`plan.torrentName` is already a validated single path
 * segment - see torrentFile.ts's sanitizePathSegment, applied to info.name;
 * prepareStagingDir falls back to a fresh sibling directory rather than
 * throwing if a stale leftover from an earlier attempt won't fully clear),
 * stages every matched file, then hands Transmission the *original* .torrent bytes
 * pointed at that directory, paused, and waits out its own verify pass.
 * Only once that verify comes back clean (100%, no error) is the torrent
 * unpaused - a partial or failed verify is left paused for the caller to
 * review rather than started half-complete. Failing to start it (e.g. a
 * dropped connection right after a good verify) is non-fatal: the torrent
 * is still correctly staged and verified, just left paused, and `started`
 * reports false so the caller can say so.
 */
export async function commitReseed(
  torrentBuf: Buffer,
  libraryRoot: string,
  stagingRoot: string,
  transmissionConfig: TransmissionConfig,
  overridesPath?: string
): Promise<ReseedCommitResult> {
  const plan = await previewReseed(torrentBuf, libraryRoot, stagingRoot, overridesPath);
  const requestedDir = join(stagingRoot, plan.torrentName);

  if (plan.matchedCount === 0) {
    // Nothing's ever staged here, so there's no staleness risk - report the
    // plain requested path rather than involving prepareStagingDir at all.
    return { ...plan, staged: false, stagedFiles: [], perTorrentDir: requestedDir };
  }

  const perTorrentDir = await prepareStagingDir(requestedDir);
  const stagedFiles = await stageMatchedFiles(plan, perTorrentDir);

  const added = await addTorrentToTransmission(transmissionConfig, torrentBuf.toString("base64"), {
    downloadDir: perTorrentDir,
    paused: true,
  });
  const verify = await pollTorrentVerification(transmissionConfig, added.id);

  let started = false;
  if (isCleanVerify(verify)) {
    try {
      await startTorrent(transmissionConfig, added.id);
      started = true;
    } catch {
      // Non-fatal - see the doc comment above. started stays false so the
      // caller can tell the user it still needs a manual Start.
    }
  }

  return { ...plan, staged: true, stagedFiles, perTorrentDir, transmission: { added, verify, started } };
}
