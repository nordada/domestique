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

import { basename, dirname } from "node:path";
import type { TorrentMetainfo } from "./torrentFile.js";
import { parseName, mergeParsed, type ParsedName } from "./parser.js";

export type FileMatchStatus = "matched" | "ambiguous" | "unmatched";

export interface FileMatch {
  relativePath: string;
  length: number;
  status: FileMatchStatus;
  /** Set when status is "matched" - the one library file to hardlink/copy into place. Either the sole same-size candidate, a filename-scored auto-guess among several (see resolvedBy: "guess"), or a human's own pick (resolvedBy: "manual"). */
  candidate?: string;
  /** Every same-size library file found for this entry, best guess first (see scoreCandidate) - capped so a pathological library can't blow up the response. Set whenever more than one same-size file existed, even after auto-guessing or a manual override resolved `candidate` from among them, so the UI can still show/reconsider the alternatives. */
  candidates?: string[];
  /** How `candidate` was decided, when it took more than "the only same-size file" to get there: "guess" for an automatic filename-score winner (see scoreCandidate/AUTO_GUESS_MIN_SCORE below), "manual" for a human's own pick recorded via matchOverrides.ts. Absent for a plain single-candidate match and for zero-length files. */
  resolvedBy?: "guess" | "manual";
}

export interface ReseedPlan {
  torrentName: string;
  files: FileMatch[];
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  /** Subset of matchedCount that got there via an automatic filename-score guess rather than a lone same-size candidate - see resolvedBy: "guess". Worth reporting separately since, unlike a plain match, it's only as good as this run's filename parsing until Transmission's own piece-hash verify actually confirms it (see reseed.ts/dedupe.ts). */
  guessedCount: number;
}

const MAX_REPORTED_CANDIDATES = 25;

// Tuned against the real DVD-boxset ambiguity case this was built for (four
// same-size "1986 Tour De France DVD1..4" library files, one torrent named
// "...DVD3") and the existing "genuinely no signal" test fixtures (same-size
// files whose names share nothing but an extension) - not derived from a
// larger corpus, so revisit if real usage turns up either a bad guess or a
// case that should have guessed but didn't.
const AUTO_GUESS_MIN_SCORE = 4;
const AUTO_GUESS_MIN_MARGIN = 3;

/**
 * Scores how plausible it is that `candidate` (an existing library file) is
 * actually the same content as `entry` (a file this torrent expects) - used
 * only to rank/auto-resolve among several same-size candidates (see
 * buildReseedPlan), never to accept a match byte size alone wouldn't already
 * support. Structured fields (stage/episode/part/year/broadcaster/
 * resolution) are the strongest signal, since two DIFFERENT stages/discs of
 * the same race are exactly the case a pure byte-size match can't tell
 * apart - a mismatch on any of them is weighted as heavily as a match, so a
 * wrong-disc candidate scores well below a merely name-different one rather
 * of just "less well." Token overlap (Jaccard similarity) is the fallback/
 * tie-breaker for everything else about the name.
 */
function scoreCandidate(entry: ParsedName, candidate: ParsedName): number {
  let score = 0;

  const compareField = (a: number | null, b: number | null, weight: number): void => {
    if (a === null || b === null) return;
    score += a === b ? weight : -weight;
  };

  compareField(entry.stageNum, candidate.stageNum, 6);
  compareField(entry.episodeNum, candidate.episodeNum, 6);
  compareField(entry.partNum, candidate.partNum, 6);
  if (entry.yearWasExplicit && candidate.yearWasExplicit) {
    score += entry.year === candidate.year ? 2 : -2;
  }
  if (entry.broadcaster && candidate.broadcaster) {
    score += entry.broadcaster === candidate.broadcaster ? 1 : -1;
  }
  compareField(entry.resolution, candidate.resolution, 1);

  const intersection = [...entry.tokenSet].filter((t) => candidate.tokenSet.has(t)).length;
  const union = new Set([...entry.tokenSet, ...candidate.tokenSet]).size;
  if (union > 0) score += (intersection / union) * 3;

  return score;
}

/** Folder+file parse of a torrent's own name for one of its entries, same "file's own fields win, folder fills gaps" convention parser.ts's mergeParsed doc comment describes. */
function parseTorrentEntry(torrentName: string, relativePath: string): ParsedName {
  return mergeParsed(parseName(torrentName), parseName(basename(relativePath)));
}

/** Same folder+file convention as parseTorrentEntry, applied to an existing library path instead - the parent directory name often carries a show/race name a terser leaf filename doesn't repeat. */
function parseLibraryCandidate(path: string): ParsedName {
  return mergeParsed(parseName(basename(dirname(path))), parseName(basename(path)));
}

/**
 * Ranks same-size `candidates` against `entry` best-first, and reports
 * whether the top one is a clear enough winner to auto-resolve: its score
 * must clear an absolute floor (AUTO_GUESS_MIN_SCORE - reject "everything
 * scored near zero, there's just nothing to go on") AND beat the runner-up
 * by a real margin (AUTO_GUESS_MIN_MARGIN - reject a near-tie, which is
 * exactly the "two candidates are both about as plausible" case that should
 * stay ambiguous for a human to pick between). A guess wrong despite
 * clearing both bars is still never silently trusted past this: every real
 * caller (reseed.ts/dedupe.ts) re-verifies the actual bytes via
 * Transmission's own piece-hash check before treating anything as settled.
 */
function rankCandidates(entry: ParsedName, candidates: string[]): { ranked: string[]; guess: string | null } {
  const scored = candidates
    .map((path) => ({ path, score: scoreCandidate(entry, parseLibraryCandidate(path)) }))
    .sort((a, b) => b.score - a.score);
  const ranked = scored.map((s) => s.path);

  const top = scored[0];
  const runnerUp = scored[1];
  const guess =
    top.score >= AUTO_GUESS_MIN_SCORE && (!runnerUp || top.score - runnerUp.score >= AUTO_GUESS_MIN_MARGIN)
      ? top.path
      : null;

  return { ranked, guess };
}

/**
 * Matches a torrent's expected files against a library size index
 * (src/libraryIndex.ts) - the first pass is purely exact byte size, same as
 * ever; when that alone leaves more than one candidate, a second pass scores
 * each one by how well its filename lines up with the torrent's own (see
 * rankCandidates) and auto-resolves a clear winner (status "matched",
 * resolvedBy "guess"), leaving anything short of that clear as "ambiguous"
 * (with candidates still ranked best-first, for a human picker to default
 * sensibly). Transmission's own piece-hash verify, not this function, is
 * what actually confirms any match - including a guessed one - is correct
 * (see src/reseed.ts). Only reads name/files - narrowed to Pick<> rather
 * than the full TorrentMetainfo so callers working from Transmission's own
 * live file list (dedupe.ts, seeding.ts), which never have a real
 * .torrent's infoHash to provide, don't need to fabricate one just to
 * satisfy this signature.
 */
export function buildReseedPlan(
  meta: Pick<TorrentMetainfo, "name" | "files">,
  sizeIndex: Map<number, string[]>
): ReseedPlan {
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

    const { ranked, guess } = rankCandidates(parseTorrentEntry(meta.name, entry.relativePath), candidates);
    const rankedCapped = ranked.slice(0, MAX_REPORTED_CANDIDATES);
    if (guess) {
      return {
        relativePath: entry.relativePath,
        length: entry.length,
        status: "matched",
        candidate: guess,
        candidates: rankedCapped,
        resolvedBy: "guess",
      };
    }
    return {
      relativePath: entry.relativePath,
      length: entry.length,
      status: "ambiguous",
      candidates: rankedCapped,
    };
  });

  return {
    torrentName: meta.name,
    files,
    matchedCount: files.filter((f) => f.status === "matched").length,
    ambiguousCount: files.filter((f) => f.status === "ambiguous").length,
    unmatchedCount: files.filter((f) => f.status === "unmatched").length,
    guessedCount: files.filter((f) => f.resolvedBy === "guess").length,
  };
}

/**
 * Promotes any still-"ambiguous" file whose relativePath has a recorded
 * manual pick (see matchOverrides.ts) to a real "matched" entry, resolvedBy
 * "manual" - the fallback for whatever a filename-score guess in
 * buildReseedPlan didn't confidently resolve on its own. Re-validates the
 * override against THIS plan's own live `candidates` list rather than
 * trusting it blindly: a stale override (the library changed since it was
 * recorded, or the candidate file was moved/renamed/deleted) is silently
 * ignored rather than force-matching a path that's no longer actually one of
 * this file's same-size candidates - safe by construction, same "never trust
 * a stored path without re-checking it's still valid" posture as
 * reseedApi.ts's other routes. Pure function, no I/O - callers load the
 * override map themselves (see matchOverrides.ts's getManualMatches).
 */
export function applyManualOverrides(plan: ReseedPlan, overrides: Record<string, string>): ReseedPlan {
  if (Object.keys(overrides).length === 0) return plan;

  const files = plan.files.map((file): FileMatch => {
    if (file.status !== "ambiguous") return file;
    const chosen = overrides[file.relativePath];
    if (!chosen || !file.candidates?.includes(chosen)) return file;
    return { ...file, status: "matched", candidate: chosen, resolvedBy: "manual" };
  });

  return {
    ...plan,
    files,
    matchedCount: files.filter((f) => f.status === "matched").length,
    ambiguousCount: files.filter((f) => f.status === "ambiguous").length,
    unmatchedCount: files.filter((f) => f.status === "unmatched").length,
    guessedCount: files.filter((f) => f.resolvedBy === "guess").length,
  };
}
