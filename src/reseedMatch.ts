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

import type { TorrentMetainfo } from "./torrentFile.js";

export type FileMatchStatus = "matched" | "ambiguous" | "unmatched";

export interface FileMatch {
  relativePath: string;
  length: number;
  status: FileMatchStatus;
  /** Set only when status is "matched" - the one library file to hardlink/copy into place. */
  candidate?: string;
  /** Set only when status is "ambiguous" - every same-size library file found, capped so a pathological library can't blow up the response. */
  candidates?: string[];
}

export interface ReseedPlan {
  torrentName: string;
  files: FileMatch[];
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
}

const MAX_REPORTED_CANDIDATES = 25;

/**
 * Matches a torrent's expected files against a library size index
 * (src/libraryIndex.ts) purely by exact byte size - deliberately never
 * guesses among multiple same-size candidates (see the "ambiguous" status);
 * Transmission's own piece-hash verify, not this function, is what actually
 * confirms a match is correct (see src/reseed.ts).
 */
export function buildReseedPlan(meta: TorrentMetainfo, sizeIndex: Map<number, string[]>): ReseedPlan {
  const files = meta.files.map((entry): FileMatch => {
    // A 0-byte file trivially "matches" every (or no) 0-byte file in the
    // library - neither outcome is meaningful, so it's just materialized
    // directly at staging time (see reseedStage.ts) rather than searched for.
    if (entry.length === 0) {
      return { relativePath: entry.relativePath, length: 0, status: "matched" };
    }

    const candidates = sizeIndex.get(entry.length) ?? [];
    if (candidates.length === 0) {
      return { relativePath: entry.relativePath, length: entry.length, status: "unmatched" };
    }
    if (candidates.length === 1) {
      return { relativePath: entry.relativePath, length: entry.length, status: "matched", candidate: candidates[0] };
    }
    return {
      relativePath: entry.relativePath,
      length: entry.length,
      status: "ambiguous",
      candidates: candidates.slice(0, MAX_REPORTED_CANDIDATES),
    };
  });

  return {
    torrentName: meta.name,
    files,
    matchedCount: files.filter((f) => f.status === "matched").length,
    ambiguousCount: files.filter((f) => f.status === "ambiguous").length,
    unmatchedCount: files.filter((f) => f.status === "unmatched").length,
  };
}
