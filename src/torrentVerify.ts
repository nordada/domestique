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

import {
  stopTorrent,
  verifyTorrent,
  pollTorrentVerification,
  startTorrent,
  type TransmissionConfig,
} from "./transmission.js";

export interface IntegrityCheckResult {
  clean: boolean;
  percentDone: number;
  error: boolean;
  errorString: string;
  /** True only when the result was clean AND the torrent wasn't already paused for some other reason - never surprise-resumes a deliberate prior pause, never resumes anything still dirty. */
  resumed: boolean;
}

/**
 * Forces a fresh Transmission piece-hash check against a torrent's current
 * on-disk data - the same reseedApi.ts/dedupe.ts verify pipeline this app
 * already trusts elsewhere, exposed directly as its own action instead of
 * only ever running as a side effect of adding or relinking a torrent.
 * Transmission never re-checks already-seeding data on its own once a
 * torrent first verifies clean, so this is the only way this app (or the
 * user) finds out about later corruption (bitrot, a failing disk) short of
 * a stream actually failing to play.
 *
 * Always pauses first (stopTorrent is idempotent, so no need to branch on
 * prior state) so a live torrent can't start pulling a bad piece from
 * peers mid-check. Only resumes automatically on a clean result and only
 * when the torrent wasn't already paused for some other reason - a dirty
 * result is always left paused for the caller to review rather than
 * silently redownloaded, and a torrent the user had already paused stays
 * paused either way.
 */
export async function checkTorrentIntegrity(
  transmissionConfig: TransmissionConfig,
  id: number,
  wasPaused: boolean
): Promise<IntegrityCheckResult> {
  await stopTorrent(transmissionConfig, id);
  await verifyTorrent(transmissionConfig, id);
  const verify = await pollTorrentVerification(transmissionConfig, id);

  const clean = verify !== null && !verify.error && verify.percentDone === 1;
  let resumed = false;
  if (clean && !wasPaused) {
    try {
      await startTorrent(transmissionConfig, id);
      resumed = true;
    } catch {
      // Non-fatal, same posture as reseed.ts's commitReseed - the check
      // itself is still valid and recorded, just left paused.
    }
  }

  return {
    clean,
    percentDone: verify?.percentDone ?? 0,
    error: Boolean(verify?.error),
    errorString: verify?.errorString ?? "",
    resumed,
  };
}
