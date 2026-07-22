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

import type { CategoryDef, ShowConfig } from "./config.js";
import type { ParsedName } from "./parser.js";
import { NOISE_TOKENS } from "./matcher.js";

export interface DestinationPlan {
  /** path relative to the Plex library root, e.g. "Tour de France/Season 2026" */
  destDir: string;
  destFilename: string;
  /** episode number this file was filed under, e.g. 0 for specials, 1 for one-day races */
  episode: number;
  warning: string | null;
}

const DISCIPLINE_TOKENS = new Set(["tt", "ttt"]);
const AGE_TOKENS = new Set(["u23", "u19", "junior"]);
const GENDER_TOKENS = new Set(["men", "women", "mixed"]);
const NATIONALS_NOISE = new Set(["national", "nationals", "championships", "road", "race"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function padPart(n: number, total: number | null): string {
  const width = Math.max(2, String(total ?? n).length);
  return String(n).padStart(width, "0");
}

function buildFilename(
  prefix: string,
  year: number,
  episode: number,
  title: string | null,
  partNum: number | null,
  partTotal: number | null,
  ext: string
): string {
  let name = `${prefix} - S${year}E${pad2(episode)}`;
  if (title) name += ` - ${title}`;
  if (partNum !== null) name += ` - pt${padPart(partNum, partTotal)}`;
  return `${name}.${ext}`;
}

function matchCategory(tokenSet: Set<string>, categories: CategoryDef[]): CategoryDef | null {
  let best: { cat: CategoryDef; score: number } | null = null;
  for (const cat of categories) {
    const excluded = (cat.exclude ?? []).some((t) => tokenSet.has(t));
    if (excluded) continue;
    const includeMatches = cat.include.filter((t) => tokenSet.has(t)).length;
    if (includeMatches !== cat.include.length) continue; // every include token must be present
    if (!best || includeMatches > best.score) {
      best = { cat, score: includeMatches };
    }
  }
  return best?.cat ?? null;
}

function guessCategoryTitle(parsed: ParsedName, matchedPhraseTokens: Set<string>): string {
  const gender = parsed.tokenSet.has("women")
    ? "Womens"
    : parsed.tokenSet.has("mixed")
      ? "Mixed"
      : parsed.tokenSet.has("men")
        ? "Mens"
        : null;

  const age = parsed.tokenSet.has("u23")
    ? "U23"
    : parsed.tokenSet.has("u19")
      ? "U19"
      : parsed.tokenSet.has("junior")
        ? "Junior"
        : null;

  const discipline = parsed.tokenSet.has("ttt")
    ? "TTT"
    : parsed.tokenSet.has("tt")
      ? "TT"
      : "Road Race";

  const consumed = new Set([
    ...matchedPhraseTokens,
    ...NATIONALS_NOISE,
    ...GENDER_TOKENS,
    ...AGE_TOKENS,
    ...DISCIPLINE_TOKENS,
  ]);
  const countryTokens = parsed.tokens.filter(
    (t) => !consumed.has(t) && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t)
  );
  const country = countryTokens
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");

  return [country, gender, age, discipline].filter(Boolean).join(" ");
}

export interface DynamicEpisodeResolver {
  (destDir: string, title: string): number | Promise<number>;
}

export async function buildDestination(
  show: ShowConfig,
  parsed: ParsedName,
  ext: string,
  matchedPhraseTokens: Set<string>,
  resolveDynamicEpisode: DynamicEpisodeResolver
): Promise<DestinationPlan> {
  const prefix = show.filenamePrefix ?? show.folderName;
  const destDir = `${show.folderName}/Season ${parsed.year}`;
  let warning: string | null = null;

  if (!parsed.yearWasExplicit) {
    warning = `No year found in "${parsed.raw}"; defaulted to ${parsed.year}`;
  }

  switch (show.type) {
    case "stage-race": {
      if (parsed.isTeamPresentation) {
        return {
          destDir,
          destFilename: buildFilename(prefix, parsed.year, 0, "Team Presentation", parsed.partNum, parsed.partTotal, ext),
          episode: 0,
          warning,
        };
      }
      if (parsed.isRoutePresentation) {
        return {
          destDir,
          destFilename: buildFilename(prefix, parsed.year, 0, "Route Presentation", parsed.partNum, parsed.partTotal, ext),
          episode: 0,
          warning,
        };
      }
      if (parsed.stageNum === null && parsed.episodeNum === null) {
        return {
          destDir,
          destFilename: buildFilename(prefix, parsed.year, 1, null, parsed.partNum, parsed.partTotal, ext),
          episode: 1,
          warning: `No stage or episode number found in "${parsed.raw}" for stage-race show "${show.id}"; defaulted to E01 with no title.`,
        };
      }
      // A real bike race always says "Stage"; a non-race multi-episode show
      // auto-created under this same type (see matcher.ts) says "Episode"
      // instead - stageNum wins if somehow both are present.
      const num = parsed.stageNum ?? parsed.episodeNum!;
      const label =
        parsed.stageNum !== null
          ? `Stage ${parsed.stageNum}${parsed.isHighlights ? " Highlights" : ""}`
          : `Episode ${parsed.episodeNum}`;
      return {
        destDir,
        destFilename: buildFilename(prefix, parsed.year, num, label, parsed.partNum, parsed.partTotal, ext),
        episode: num,
        warning,
      };
    }

    case "one-day": {
      return {
        destDir,
        destFilename: buildFilename(prefix, parsed.year, 1, null, parsed.partNum, parsed.partTotal, ext),
        episode: 1,
        warning,
      };
    }

    case "multi-category-fixed": {
      const category = matchCategory(parsed.tokenSet, show.categories ?? []);
      if (category) {
        return {
          destDir,
          destFilename: buildFilename(prefix, parsed.year, category.episode, category.title, parsed.partNum, parsed.partTotal, ext),
          episode: category.episode,
          warning,
        };
      }
      // Fell through the fixed table: degrade to dynamic numbering rather than failing.
      const title = guessCategoryTitle(parsed, matchedPhraseTokens);
      const episode = await resolveDynamicEpisode(destDir, title);
      return {
        destDir,
        destFilename: buildFilename(prefix, parsed.year, episode, title, parsed.partNum, parsed.partTotal, ext),
        episode,
        warning: `"${parsed.raw}" didn't match any configured category for show "${show.id}"; assigned dynamically as "${title}" (E${pad2(episode)}). Consider adding this category to config/events.json.`,
      };
    }

    case "multi-category-dynamic": {
      const title = guessCategoryTitle(parsed, matchedPhraseTokens);
      const episode = await resolveDynamicEpisode(destDir, title);
      return {
        destDir,
        destFilename: buildFilename(prefix, parsed.year, episode, title, parsed.partNum, parsed.partTotal, ext),
        episode,
        warning,
      };
    }
  }
}
