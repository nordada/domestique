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

export interface ParsedName {
  /** raw input, unmodified */
  raw: string;
  /** four-digit year; falls back to the current calendar year if none was found in the name */
  year: number;
  yearWasExplicit: boolean;
  /** stage number, e.g. 4 for "Stage-04" */
  stageNum: number | null;
  /** generic episode number, e.g. 4 for "Episode 4" or "Ep04" - for non-stage-race content (see parseName) */
  episodeNum: number | null;
  /** part number within a multi-part file, e.g. 2 for "(Part-2-of-3)" */
  partNum: number | null;
  /** total part count, when known (present in "(Part-N-of-M)" style, absent in bare "PartN" style) */
  partTotal: number | null;
  /** vertical resolution in pixels, e.g. 1080 for "1080p"; null if not present in the name */
  resolution: number | null;
  /** broadcaster/commentary source (canonical display form, e.g. "Eurosport"), when recognized */
  broadcaster: string | null;
  isHighlights: boolean;
  isTeamPresentation: boolean;
  isRoutePresentation: boolean;
  /** normalized tokens remaining after year/stage/part extraction, aliased (mens->men, itt->tt, etc.) */
  tokens: string[];
  /** same tokens as a Set, for containment checks */
  tokenSet: Set<string>;
}

const TOKEN_ALIASES: Record<string, string> = {
  mens: "men",
  man: "men",
  male: "men",
  womens: "women",
  woman: "women",
  female: "women",
  donna: "donne", // Italian singular "woman" -> the plural form config/events.json standardizes on for Giro Donne
  juniors: "junior",
  itt: "tt",
};

/**
 * Known broadcaster/commentary sources, mapped to their canonical display
 * form for use in "alternate version" filenames (see fileops.ts). Extend
 * this list as new ones show up in your tracker's release names - it's a
 * small, slowly-changing set, unlike race names, so it lives here rather
 * than in config/events.json.
 */
const BROADCASTER_TOKENS: Record<string, string> = {
  eurosport: "Eurosport",
  sbs: "SBS",
  tnt: "TNT",
  rcs: "RCS",
  gcn: "GCN",
  nbc: "NBC",
  itv4: "ITV4",
  flobikes: "FloBikes",
  ucichannel: "UCI Channel",
  nos: "NOS",
  sporza: "Sporza",
  rai: "RAI",
  francetv: "France TV",
};

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(COMBINING_DIACRITICS, "");
}

function extractAndRemove(
  working: string,
  regex: RegExp
): { match: RegExpMatchArray | null; working: string } {
  const match = working.match(regex);
  if (!match || match.index === undefined) {
    return { match: null, working };
  }
  const before = working.slice(0, match.index);
  const after = working.slice(match.index + match[0].length);
  return { match, working: `${before} ${after}` };
}

export function parseName(rawInput: string): ParsedName {
  const raw = rawInput;

  let working = stripDiacritics(rawInput.toLowerCase());
  working = working.replace(/['’]/g, ""); // "D'Italia" -> "ditalia", "l'Ain" -> "lain"

  const isHighlights = /highlights?/.test(working);
  const isTeamPresentation = /team[-_. ]?presentation/.test(working);
  const isRoutePresentation = /route[-_. ]?presentation/.test(working);

  // Year: no \b, since torrent names often glue it directly onto a prefix
  // ("tdf2026-stage04..."). Covers 19xx too, not just 20xx - archival race
  // footage (VHS/DVD rips from the 1990s, say) has a real, explicit year
  // just as often as a modern release does; the original 20xx-only version
  // of this regex would silently default a torrent's own genuine "1993" to
  // the current year instead of ever matching it.
  const yearExtraction = extractAndRemove(working, /((?:19|20)\d{2})/);
  working = yearExtraction.working;
  const yearWasExplicit = yearExtraction.match !== null;
  const year = yearWasExplicit
    ? parseInt(yearExtraction.match![1], 10)
    : new Date().getFullYear();

  // Stage number: "Stage-01", "stage04", "Stage 4"
  const stageExtraction = extractAndRemove(working, /stage[-_. ]?0*(\d+)/i);
  working = stageExtraction.working;
  const stageNum = stageExtraction.match ? parseInt(stageExtraction.match[1], 10) : null;

  // Generic episode number for non-stage-race content: "Episode 4", "Episode-04",
  // "Ep4" - kept separate from stageNum (a real bike race says "Stage", never
  // "Episode") so auto-created stage-race shows never see this fire by
  // accident, but a multi-episode show that isn't a stage race still gets a
  // real per-file episode number instead of every file collapsing onto E01.
  const episodeExtraction = extractAndRemove(working, /episode[-_. ]?0*(\d+)/i);
  working = episodeExtraction.working;
  let episodeNum = episodeExtraction.match ? parseInt(episodeExtraction.match[1], 10) : null;
  if (episodeNum === null) {
    const epAbbrevExtraction = extractAndRemove(working, /\bep[-_. ]?0*(\d+)\b/i);
    working = epAbbrevExtraction.working;
    episodeNum = epAbbrevExtraction.match ? parseInt(epAbbrevExtraction.match[1], 10) : null;
  }

  // Part-with-total: "(Part-1-of-2)", "Part_1_of_2"
  const partOfExtraction = extractAndRemove(
    working,
    /part[-_. ]?(\d+)[-_. ]?of[-_. ]?(\d+)/i
  );
  working = partOfExtraction.working;
  let partNum: number | null = null;
  let partTotal: number | null = null;
  if (partOfExtraction.match) {
    partNum = parseInt(partOfExtraction.match[1], 10);
    partTotal = parseInt(partOfExtraction.match[2], 10);
  } else {
    // Bare part, no known total: "SBS_HD_Part1", "Part-2"
    const partOnlyExtraction = extractAndRemove(working, /part[-_. ]?0*(\d+)/i);
    working = partOnlyExtraction.working;
    if (partOnlyExtraction.match) {
      partNum = parseInt(partOnlyExtraction.match[1], 10);
    } else {
      // Bare "N of M" with no "part" keyword at all, e.g. "1of2", "2 of 2" -
      // seen on some trackers for stages split across multiple video files.
      const bareOfExtraction = extractAndRemove(working, /\b(\d+)[-_. ]?of[-_. ]?(\d+)\b/i);
      working = bareOfExtraction.working;
      if (bareOfExtraction.match) {
        partNum = parseInt(bareOfExtraction.match[1], 10);
        partTotal = parseInt(bareOfExtraction.match[2], 10);
      } else {
        // "Disc N" / "CD N" - the same idea as Part N but from older
        // multi-disc DVD-rip-style releases (e.g. a "(Complete)" boxset
        // split across several .avi files, one per disc). Treated as an
        // alias for a bare part number so it reuses the existing pt0N
        // naming/grouping machinery rather than needing its own concept -
        // without this, every disc parses to the exact same identity and
        // only the first one can ever be filed, the rest permanently
        // "destination already exists".
        const discExtraction = extractAndRemove(working, /\b(?:disc|cd)[-_. ]?0*(\d+)\b/i);
        working = discExtraction.working;
        if (discExtraction.match) {
          partNum = parseInt(discExtraction.match[1], 10);
        } else {
          // Raw DVD-Video rip naming: "VTS_01_2" is title-set 01, video
          // segment 2 - old DVDs split one continuous title across several
          // ~1GB VOB files purely due to filesystem size limits, so segment
          // number is genuinely a part number (the title-set number itself
          // is ignored - see fileops.ts's resolveSourceItems, which already
          // filters out the "part 0" navigation-only .BUP/.IFO/VIDEO_TS.VOB
          // files entirely before parsing ever sees them, so every VTS file
          // that reaches here is real video content).
          const vtsExtraction = extractAndRemove(working, /\bvts[-_. ]?0*(\d+)[-_. ]?0*(\d+)\b/i);
          working = vtsExtraction.working;
          if (vtsExtraction.match) {
            partNum = parseInt(vtsExtraction.match[2], 10);
          }
        }
      }
    }
  }

  // Resolution: "720p", "1080p", "2160p" - always its own token in real data
  // (never glued to a neighboring word like year sometimes is), so \b is safe.
  const resolutionExtraction = extractAndRemove(working, /(\d{3,4})p\b/i);
  working = resolutionExtraction.working;
  const resolution = resolutionExtraction.match
    ? parseInt(resolutionExtraction.match[1], 10)
    : null;

  // Merge "u 23" / "u-23" / "u_23" -> "u23" before splitting, same for u19, so they survive as one token.
  working = working.replace(/u[\s_-]?23\b/gi, "u23");
  working = working.replace(/u[\s_-]?19\b/gi, "u19");

  const rawTokens = working
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const tokens = rawTokens.map((t) => TOKEN_ALIASES[t] ?? t);
  const tokenSet = new Set(tokens);

  let broadcaster: string | null = null;
  for (const [token, label] of Object.entries(BROADCASTER_TOKENS)) {
    if (tokenSet.has(token)) {
      broadcaster = label;
      break;
    }
  }

  return {
    raw,
    year,
    yearWasExplicit,
    stageNum,
    episodeNum,
    partNum,
    partTotal,
    resolution,
    broadcaster,
    isHighlights,
    isTeamPresentation,
    isRoutePresentation,
    tokens,
    tokenSet,
  };
}

/**
 * Combines a folder-level parse with a file-level parse for torrents that
 * download as a directory of files (e.g. grand tour stage folders). The file
 * name's own explicit fields win; folder fields fill in anything the file
 * name didn't specify (useful if an inner file is named more tersely than
 * the folder it lives in). Tokens are unioned so show-matching benefits from
 * both sources of context.
 */
export function mergeParsed(folder: ParsedName, file: ParsedName): ParsedName {
  return {
    raw: file.raw,
    year: file.yearWasExplicit ? file.year : folder.yearWasExplicit ? folder.year : file.year,
    yearWasExplicit: file.yearWasExplicit || folder.yearWasExplicit,
    stageNum: file.stageNum ?? folder.stageNum,
    episodeNum: file.episodeNum ?? folder.episodeNum,
    partNum: file.partNum ?? folder.partNum,
    partTotal: file.partTotal ?? folder.partTotal,
    resolution: file.resolution ?? folder.resolution,
    broadcaster: file.broadcaster ?? folder.broadcaster,
    isHighlights: file.isHighlights || folder.isHighlights,
    isTeamPresentation: file.isTeamPresentation || folder.isTeamPresentation,
    isRoutePresentation: file.isRoutePresentation || folder.isRoutePresentation,
    tokens: Array.from(new Set([...folder.tokens, ...file.tokens])),
    tokenSet: new Set([...folder.tokenSet, ...file.tokenSet]),
  };
}
