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
 * Builds the Index tab's one unified list - every torrent Domestique has a
 * saved .torrent for (see torrentRegistry.ts), each enriched with a live
 * Plex-library match and a live Transmission match. Supersedes the old
 * separate "Currently seeding" list (seeding.ts's now-removed
 * listSeedingTorrents) and the old registry route's inline enrichment -
 * this is the one place that logic lives now. The registered .torrent
 * itself is the one source of truth for identity/name/file-list: nothing
 * here is cached beyond the raw bytes torrentRegistry.ts stores, everything
 * else (name, files, size) is re-derived by parsing that file fresh on
 * every call.
 */

import { buildSizeIndex } from "./libraryIndex.js";
import { buildReseedPlan, type ReseedPlan } from "./reseedMatch.js";
import { getAllTorrentsWithFiles, type TransmissionConfig } from "./transmission.js";
import { listRegistry, getRegisteredTorrentBuf } from "./torrentRegistry.js";
import { parseTorrentFile } from "./torrentFile.js";
import { computeStorageStatus, findOrphanOriginal, computePercentComplete, type StorageStatus, type OrphanOriginal } from "./seeding.js";
import { getVerifyResult, type VerifyRecord } from "./verifyState.js";

export interface TorrentIndexEntry {
  infoHash: string;
  torrentName: string;
  /** Total content size (sum of the torrent's own file lengths) - not the tiny .torrent metadata file's own byte size, which isn't interesting to show. */
  totalBytes: number;
  /** When this .torrent was registered (file mtime) - either a real Reseed commit, or the moment transmissionTorrentSync.ts first saw it in Transmission's own torrents directory. */
  addedAt: string;
  /** Size-matched against the *current* library - same rigor as everywhere else in this app (see reseedMatch.ts). Reused by the UI to render per-file matched paths via the existing planFilesHtml renderer. */
  plan: ReseedPlan;
  inPlex: boolean;
  inTransmission: boolean;
  /** Transmission's own numeric id - null unless inTransmission, since that's what every action route (dedupe/remove/add-to-library) actually operates on. */
  transmissionId: number | null;
  /** Transmission's raw RPC status (0=stopped/paused, 6=seeding, others=downloading/checking/etc) - null unless inTransmission. Left as the raw number, same as the old Currently-seeding list; display labeling is a UI concern. */
  status: number | null;
  percentDone: number | null;
  percentComplete: number | null;
  storageStatus: StorageStatus;
  orphanOriginal: OrphanOriginal | null;
  ratio: number | null;
  /** Most recent forced piece-hash re-check (see torrentVerify.ts), if this torrent's ever had one - null for one that's never been through a "Verify data" run. Kept even after the torrent drops out of Transmission, so a flagged-dirty result stays visible rather than silently disappearing the moment it's removed. */
  lastVerify: VerifyRecord | null;
}

export interface TorrentIndexSummary {
  total: number;
  inPlexCount: number;
  inTransmissionCount: number;
  seedingCount: number;
}

export interface BuildTorrentIndexOptions {
  registryDir: string;
  libraryRoot: string;
  stagingRoot: string;
  downloadsPath: string;
  dedupeStatePath: string;
  verifyStatePath: string;
  transmissionConfig: TransmissionConfig | null;
}

// From Transmission's RPC spec (tr_torrent_activity): 6 = seeding.
const STATUS_SEEDING = 6;

export async function buildTorrentIndex(
  opts: BuildTorrentIndexOptions
): Promise<{ entries: TorrentIndexEntry[]; summary: TorrentIndexSummary }> {
  const registryEntries = await listRegistry(opts.registryDir);
  const sizeIndex = await buildSizeIndex(opts.libraryRoot, { excludeDirs: [opts.stagingRoot] });

  let liveByHash = new Map<string, Awaited<ReturnType<typeof getAllTorrentsWithFiles>>[number]>();
  if (opts.transmissionConfig) {
    try {
      const liveTorrents = await getAllTorrentsWithFiles(opts.transmissionConfig);
      liveByHash = new Map(liveTorrents.map((t) => [t.hashString.toLowerCase(), t]));
    } catch (err) {
      console.warn(`[torrent-index] failed to fetch live Transmission torrents: ${err}`);
    }
  }

  const entries = await Promise.all(
    registryEntries.map(async (regEntry): Promise<TorrentIndexEntry | null> => {
      const buf = await getRegisteredTorrentBuf(regEntry.infoHash, opts.registryDir);
      if (!buf) return null; // vanished between listRegistry and here - skip rather than crash the whole index
      let meta;
      try {
        meta = parseTorrentFile(buf);
      } catch {
        // A saved .torrent that no longer parses cleanly (shouldn't happen -
        // this app wrote it - but stay defensive, same posture the old
        // registry route already took).
        return null;
      }

      const plan = buildReseedPlan(meta, sizeIndex);
      const inPlex = plan.files.length > 0 && plan.matchedCount === plan.files.length;
      const totalBytes = meta.files.reduce((sum, f) => sum + f.length, 0);
      const lastVerify = getVerifyResult(regEntry.infoHash, opts.verifyStatePath);

      const live = liveByHash.get(meta.infoHash.toLowerCase());
      if (!live) {
        return {
          infoHash: regEntry.infoHash,
          torrentName: meta.name,
          totalBytes,
          addedAt: regEntry.addedAt,
          plan,
          inPlex,
          inTransmission: false,
          transmissionId: null,
          status: null,
          percentDone: null,
          percentComplete: null,
          storageStatus: "n/a",
          orphanOriginal: null,
          ratio: null,
          lastVerify,
        };
      }

      const percentComplete = computePercentComplete(live.files);
      const storageStatus = await computeStorageStatus(plan, live.downloadDir, percentComplete);
      return {
        infoHash: regEntry.infoHash,
        torrentName: meta.name,
        totalBytes,
        addedAt: regEntry.addedAt,
        plan,
        inPlex,
        inTransmission: true,
        transmissionId: live.id,
        status: live.status,
        percentDone: live.percentDone,
        percentComplete,
        storageStatus,
        orphanOriginal:
          storageStatus === "deduped" ? await findOrphanOriginal(plan, opts.downloadsPath, opts.dedupeStatePath) : null,
        ratio: live.uploadRatio,
        lastVerify,
      };
    })
  );

  const filtered = entries.filter((e): e is TorrentIndexEntry => e !== null);

  return {
    entries: filtered,
    summary: {
      total: filtered.length,
      inPlexCount: filtered.filter((e) => e.inPlex).length,
      inTransmissionCount: filtered.filter((e) => e.inTransmission).length,
      seedingCount: filtered.filter((e) => e.status === STATUS_SEEDING).length,
    },
  };
}
