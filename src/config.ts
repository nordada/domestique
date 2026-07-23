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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureSeeded } from "./fileseed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ShowType =
  | "stage-race" // numbered stages, E00 reserved for specials (Team/Route Presentation)
  | "one-day" // single race per season, no title segment (just E01)
  | "multi-category-fixed" // multiple categories per season, fixed episode order (e.g. Worlds)
  | "multi-category-dynamic"; // multiple categories per season, episode assigned by first-come order (e.g. Nationals, where the category set is open-ended across countries)

export interface CategoryDef {
  episode: number;
  title: string;
  /** normalized tokens that must ALL be present in the source name for this category to match */
  include: string[];
  /** normalized tokens that must NOT be present (used to disambiguate elite vs u23/junior, RR vs TT) */
  exclude?: string[];
}

/** Per-event override of Settings.coverArt - any field left unset falls back to the global setting. */
export interface ShowCoverArtOverride {
  backgroundColor?: string;
  backgroundColor2?: string;
  logoScale?: number;
}

export interface ShowConfig {
  id: string;
  /** Plex show folder name, under the library root */
  folderName: string;
  /** filename prefix used in the destination filename; defaults to folderName if omitted */
  filenamePrefix?: string;
  /** alternate phrases (space-separated token sets) that identify this show from a raw torrent name */
  matchKeywords: string[];
  type: ShowType;
  /** true if this entry is itself a "highlights" variant of another race */
  isHighlights?: boolean;
  /** required for multi-category-fixed; ignored otherwise */
  categories?: CategoryDef[];
  /** set on entries created automatically for unrecognized races */
  autoCreated?: boolean;
  /** optional per-event cover-art customization; omitted entirely means "use Settings.coverArt as-is" */
  coverArt?: ShowCoverArtOverride;
}

export interface ShowsConfigFile {
  shows: ShowConfig[];
}

const DEFAULT_CONFIG_PATH = join(__dirname, "..", "config", "events.json");

/**
 * A bind-mounted appdata path (e.g. a fresh Unraid/CA install with nothing
 * there yet) starts out with nothing at that path - seed it from the image's
 * own bundled starter config rather than crash-looping on every request.
 */
function ensureConfigSeeded(path: string): void {
  if (path === DEFAULT_CONFIG_PATH || !existsSync(DEFAULT_CONFIG_PATH)) return;
  const seeded = ensureSeeded(path, () => readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));
  if (seeded) console.log(`[config] seeded missing config at ${path} from the bundled default`);
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): ShowsConfigFile {
  ensureConfigSeeded(path);
  if (!existsSync(path)) {
    throw new Error(`Config file not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as ShowsConfigFile;
  validateConfig(parsed);
  return parsed;
}

export function saveConfig(config: ShowsConfigFile, path: string = DEFAULT_CONFIG_PATH): void {
  validateConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function validateConfig(config: ShowsConfigFile): void {
  if (!config || !Array.isArray(config.shows)) {
    throw new Error("Invalid config: expected { shows: ShowConfig[] }");
  }
  const seenIds = new Set<string>();
  for (const show of config.shows) {
    if (!show.id || !show.folderName || !Array.isArray(show.matchKeywords)) {
      throw new Error(`Invalid show config entry: ${JSON.stringify(show)}`);
    }
    if (seenIds.has(show.id)) {
      throw new Error(`Duplicate show id in config: ${show.id}`);
    }
    seenIds.add(show.id);
    if (show.type === "multi-category-fixed" && (!show.categories || show.categories.length === 0)) {
      throw new Error(`Show "${show.id}" is multi-category-fixed but has no categories defined`);
    }
  }
}

export { DEFAULT_CONFIG_PATH };
