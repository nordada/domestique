export interface ParsedName {
  /** raw input, unmodified */
  raw: string;
  /** four-digit year; falls back to the current calendar year if none was found in the name */
  year: number;
  yearWasExplicit: boolean;
  /** stage number, e.g. 4 for "Stage-04" */
  stageNum: number | null;
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
 * this list as new ones show up in your tracker's release names — it's a
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

  // Year: no \b, since torrent names often glue it directly onto a prefix ("tdf2026-stage04...")
  const yearExtraction = extractAndRemove(working, /(20\d{2})/);
  working = yearExtraction.working;
  const yearWasExplicit = yearExtraction.match !== null;
  const year = yearWasExplicit
    ? parseInt(yearExtraction.match![1], 10)
    : new Date().getFullYear();

  // Stage number: "Stage-01", "stage04", "Stage 4"
  const stageExtraction = extractAndRemove(working, /stage[-_. ]?0*(\d+)/i);
  working = stageExtraction.working;
  const stageNum = stageExtraction.match ? parseInt(stageExtraction.match[1], 10) : null;

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
      // Bare "N of M" with no "part" keyword at all, e.g. "1of2", "2 of 2" —
      // seen on some trackers for stages split across multiple video files.
      const bareOfExtraction = extractAndRemove(working, /\b(\d+)[-_. ]?of[-_. ]?(\d+)\b/i);
      working = bareOfExtraction.working;
      if (bareOfExtraction.match) {
        partNum = parseInt(bareOfExtraction.match[1], 10);
        partTotal = parseInt(bareOfExtraction.match[2], 10);
      }
    }
  }

  // Resolution: "720p", "1080p", "2160p" — always its own token in real data
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
