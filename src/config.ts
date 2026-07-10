import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
}

export interface ShowsConfigFile {
  shows: ShowConfig[];
}

const DEFAULT_CONFIG_PATH = join(__dirname, "..", "config", "events.json");

/**
 * A bind-mounted appdata path (e.g. a fresh Unraid/CA install with nothing
 * there yet) starts out with nothing at that path - seed it from the image's
 * own bundled starter config rather than crash-looping on every request.
 * Also handles the well-known Docker bind-mount gotcha where mounting a host
 * file that doesn't exist yet onto a container file path silently creates an
 * empty DIRECTORY there instead (not a missing path), which would otherwise
 * surface as a confusing EISDIR crash.
 */
function ensureConfigSeeded(path: string): void {
  if (path === DEFAULT_CONFIG_PATH || !existsSync(DEFAULT_CONFIG_PATH)) return;

  let needsSeed = !existsSync(path);
  if (!needsSeed && statSync(path).isDirectory()) {
    if (readdirSync(path).length > 0) {
      throw new Error(
        `Expected a config file at ${path} but found a non-empty directory - check your volume mount.`,
      );
    }
    rmdirSync(path);
    needsSeed = true;
  }

  if (needsSeed) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(DEFAULT_CONFIG_PATH, path);
    console.log(`[config] seeded missing config at ${path} from the bundled default`);
  }
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
