import type { ShowConfig, ShowsConfigFile } from "./config.js";
import type { ParsedName } from "./parser.js";

export interface MatchResult {
  show: ShowConfig;
  /** number of keyword tokens matched; higher = more specific/confident match */
  specificity: number;
  /** the tokens of the matchKeywords phrase that won, so callers can exclude them from title-guessing */
  matchedTokens: Set<string>;
  autoCreated: boolean;
}

// Tokens that are real signal for matching against curated config entries
// (e.g. "eurosport" disambiguates TdF Euro Hghlights) but are just release-quality
// / broadcaster noise when guessing a display name or matchKeywords for a brand
// new auto-created show. Only used for those cosmetic purposes below, never to
// filter the ParsedName.tokenSet itself.
export const NOISE_TOKENS = new Set([
  "720p",
  "1080p",
  "2160p",
  "480p",
  "576p",
  "25fps",
  "30fps",
  "50fps",
  "60fps",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "webrip",
  "web",
  "hdtv",
  "bluray",
  "brrip",
  "dvdrip",
  "sdtv",
  "hd",
  "sd",
  "highlights",
  "highlight",
  "sbs",
  "tnt",
  "eurosport",
  "gcn",
  "nbc",
  "itv4",
  "flobikes",
  "ucichannel",
  "channel",
  "ondemand",
]);

function phraseTokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * A show matches if every token in one of its matchKeywords phrases is present
 * in the source's token set. Among all matching shows, the one whose matched
 * phrase has the most tokens wins (most specific), e.g. "tour de france eurosport"
 * (4 tokens) beats "tour de france" (3 tokens) when "eurosport" is present.
 */
function bestMatch(
  tokenSet: Set<string>,
  candidates: ShowConfig[]
): { show: ShowConfig; specificity: number; matchedTokens: Set<string> } | null {
  let best: { show: ShowConfig; specificity: number; matchedTokens: Set<string> } | null = null;
  for (const show of candidates) {
    for (const phrase of show.matchKeywords) {
      const tokens = phraseTokens(phrase);
      if (tokens.length === 0) continue;
      const allPresent = tokens.every((t) => tokenSet.has(t));
      if (allPresent && (!best || tokens.length > best.specificity)) {
        best = { show, specificity: tokens.length, matchedTokens: new Set(tokens) };
      }
    }
  }
  return best;
}

function titleCaseFromTokens(tokens: string[]): string {
  return tokens
    .filter((t) => !NOISE_TOKENS.has(t) && !/^\d+$/.test(t))
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

let autoCreateCounter = 0;

export function matchShow(parsed: ParsedName, config: ShowsConfigFile): MatchResult {
  const pool = config.shows.filter((s) => Boolean(s.isHighlights) === parsed.isHighlights);
  const match = bestMatch(parsed.tokenSet, pool);
  if (match) {
    return {
      show: match.show,
      specificity: match.specificity,
      matchedTokens: match.matchedTokens,
      autoCreated: false,
    };
  }

  // Best-effort auto-create: guess a display name from the leftover tokens
  // and file it under a new show. Logged loudly so the user can clean up the
  // config/folder afterward (rename, merge into an existing show, etc).
  //
  // Type defaults to "stage-race" whenever a stage number was actually
  // parsed, rather than always "one-day" - a one-day show always files as
  // E01 with no title, which would otherwise silently collapse every stage
  // of an unrecognized stage race onto the same filename (this is exactly
  // what happened with Tour de Suisse Women's highlights before this show
  // had its own config entry: stage number got discarded and later stages
  // collided with/overwrote earlier ones).
  const guessedName =
    titleCaseFromTokens(parsed.tokens) || `Unrecognized Race ${++autoCreateCounter}`;
  const id = guessedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const newShow: ShowConfig = {
    id: parsed.isHighlights ? `${id}-highlights` : id,
    folderName: parsed.isHighlights ? `${guessedName} HIGHLIGHTS` : guessedName,
    filenamePrefix: guessedName,
    matchKeywords: [
      parsed.tokens.filter((t) => !NOISE_TOKENS.has(t) && !/^\d+$/.test(t)).join(" "),
    ],
    type: parsed.stageNum !== null ? "stage-race" : "one-day",
    isHighlights: parsed.isHighlights || undefined,
    autoCreated: true,
  };

  // Guard against id collisions between two distinct auto-created shows
  // (e.g. noise-stripping happens to leave the same leftover tokens for two
  // different releases) so saveConfig's duplicate-id check never throws.
  let uniqueId = newShow.id;
  let suffix = 2;
  while (config.shows.some((s) => s.id === uniqueId)) {
    uniqueId = `${newShow.id}-${suffix++}`;
  }
  newShow.id = uniqueId;

  config.shows.push(newShow);

  return { show: newShow, specificity: 0, matchedTokens: new Set(), autoCreated: true };
}
