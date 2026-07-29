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

import { buildSizeIndex } from "./libraryIndex.js";
import { buildReseedPlan, type ReseedPlan } from "./reseedMatch.js";
import { getAllTorrentsWithFiles, type TransmissionConfig } from "./transmission.js";

// From Transmission's RPC spec (tr_torrent_activity): 0 = stopped (what
// Transmission's own UI calls "paused"), 6 = seeding. Deliberately narrower
// than "everything Transmission has" (skips downloading/checking/queued
// states) - this view is about what's DONE and either seeding or sitting
// paused, not download progress.
const STATUS_STOPPED = 0;
const STATUS_SEEDING = 6;
const SEEDING_OR_PAUSED = new Set([STATUS_STOPPED, STATUS_SEEDING]);

export interface SeedingTorrent {
  id: number;
  name: string;
  status: number;
  /**
   * Transmission's own RPC `percentDone` - kept for reference, but
   * deliberately NOT what the UI treats as the trustworthy figure (see
   * percentComplete below). Transmission computes this only over "wanted"
   * files: a torrent with some/all files deselected can legitimately
   * report 100% done while having zero of those bytes actually on disk -
   * a real, known Transmission RPC quirk, not a bug in the math itself.
   */
  percentDone: number;
  /**
   * Our own byte-accurate figure instead: sum(files[].bytesCompleted) /
   * sum(files[].length) across every file Transmission reports, regardless
   * of wanted/unwanted state. This is what's actually present on disk
   * right now - the number that actually matters when deciding whether
   * it's safe to remove a torrent's data.
   */
  percentComplete: number;
  /** Size-matched against the *current* library, the same way reseedMatch.ts matches a torrent file's own expected layout - not persisted, not tied to whether this torrent was ever reseeded through this app. A torrent reseeded through the Reseed tab still resolves correctly here: its staged files live under the (excluded) staging directory, but the original library file it was hardlinked from is still found by the same size search. */
  plan: ReseedPlan;
}

function computePercentComplete(files: { length: number; bytesCompleted: number }[]): number {
  const totalLength = files.reduce((sum, f) => sum + f.length, 0);
  if (totalLength === 0) return 0;
  const totalCompleted = files.reduce((sum, f) => sum + f.bytesCompleted, 0);
  return totalCompleted / totalLength;
}

/**
 * Lists every torrent Transmission is currently seeding or has paused
 * (stopped), each matched against the library by file size - the same
 * size-only matching reseedMatch.ts uses, just fed from Transmission's own
 * live file list instead of an uploaded .torrent. Covers every torrent
 * Transmission knows about, not just ones added via this app's Reseed tab,
 * since Transmission itself is the source of truth for what's seeding.
 * Skips the library walk entirely (and returns an empty list) if nothing
 * is in a seeding/paused state, since there'd be nothing to match against.
 */
export async function listSeedingTorrents(
  transmissionConfig: TransmissionConfig,
  libraryRoot: string,
  stagingRoot: string
): Promise<SeedingTorrent[]> {
  const torrents = await getAllTorrentsWithFiles(transmissionConfig);
  const relevant = torrents.filter((t) => SEEDING_OR_PAUSED.has(t.status));
  if (relevant.length === 0) return [];

  const sizeIndex = await buildSizeIndex(libraryRoot, { excludeDirs: [stagingRoot] });

  return relevant.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    percentDone: t.percentDone,
    percentComplete: computePercentComplete(t.files),
    plan: buildReseedPlan(
      { name: t.name, files: t.files.map((f) => ({ relativePath: f.name, length: f.length })) },
      sizeIndex
    ),
  }));
}
