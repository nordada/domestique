import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureSeeded } from "./fileseed.js";
import { plexConfigFromEnv, type PlexConfig } from "./plex.js";
import { discordConfigFromEnv, type DiscordConfig } from "./discord.js";
import { hotfolderConfigFromEnv, type HotfolderConfig } from "./hotfolder.js";

export interface HotfolderSettings {
  dir: string;
  pollIntervalMs: number;
  stablePolls: number;
}

export interface Settings {
  plex: PlexConfig | null;
  discord: DiscordConfig | null;
  hotfolder: HotfolderSettings | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS_PATH = join(__dirname, "..", "config", "settings.json");

/**
 * Builds the settings the app would use with nothing on disk yet, snapshotted
 * from the PLEX_, DISCORD_, and HOTFOLDER_ env vars this project has always
 * read - this is the one-time migration path for existing deployments the
 * first time settings.json doesn't exist yet.
 */
function seedFromEnv(libraryRoot: string): Settings {
  const hotfolder = hotfolderConfigFromEnv();
  return {
    plex: plexConfigFromEnv(libraryRoot),
    discord: discordConfigFromEnv(),
    hotfolder: hotfolder
      ? { dir: hotfolder.dir, pollIntervalMs: hotfolder.pollIntervalMs, stablePolls: hotfolder.stablePolls }
      : null,
  };
}

/**
 * Coerces arbitrary parsed JSON (or a fresh env-var snapshot) into a
 * well-formed Settings object. Mirrors the env parsers' own forgiving
 * "all required fields present, else disabled" rule for each section rather
 * than hard-erroring on a partial fill - e.g. filling in a Plex URL and
 * token but not a section id just leaves Plex disabled, the same as leaving
 * PLEX_SECTION_ID unset today. `appLibraryRoot` resolves a blank/omitted
 * Plex library-root override the same way plexConfigFromEnv already falls
 * back to the app's own LIBRARY_ROOT.
 */
function normalizeSettings(input: unknown, appLibraryRoot: string): Settings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    plex: normalizePlex(raw.plex, appLibraryRoot),
    discord: normalizeDiscord(raw.discord),
    hotfolder: normalizeHotfolder(raw.hotfolder),
  };
}

function normalizePlex(input: unknown, appLibraryRoot: string): PlexConfig | null {
  if (!input || typeof input !== "object") return null;
  const { url, token, sectionId, libraryRoot } = input as Record<string, unknown>;
  if (typeof url !== "string" || typeof token !== "string" || typeof sectionId !== "string") return null;
  if (!url.trim() || !token.trim() || !sectionId.trim()) return null;

  return {
    url: url.replace(/\/$/, ""),
    token,
    sectionId,
    libraryRoot: typeof libraryRoot === "string" && libraryRoot.trim() ? libraryRoot : appLibraryRoot,
  };
}

function normalizeDiscord(input: unknown): DiscordConfig | null {
  if (!input || typeof input !== "object") return null;
  const { webhookUrl, mentionUserId } = input as Record<string, unknown>;
  if (typeof webhookUrl !== "string" || !webhookUrl.trim()) return null;

  return {
    webhookUrl,
    mentionUserId: typeof mentionUserId === "string" && mentionUserId.trim() ? mentionUserId : undefined,
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHotfolder(input: unknown): HotfolderSettings | null {
  if (!input || typeof input !== "object") return null;
  const { dir, pollIntervalMs, stablePolls } = input as Record<string, unknown>;
  if (typeof dir !== "string" || !dir.trim()) return null;

  return {
    dir,
    pollIntervalMs: normalizePositiveInt(pollIntervalMs, 60000),
    stablePolls: normalizePositiveInt(stablePolls, 3),
  };
}

/** Derives the full HotfolderConfig (adds the "processed" subfolder) for callers that need it. */
export function toHotfolderConfig(settings: HotfolderSettings): HotfolderConfig {
  return {
    dir: settings.dir,
    processedDir: join(settings.dir, "processed"),
    pollIntervalMs: settings.pollIntervalMs,
    stablePolls: settings.stablePolls,
  };
}

function ensureSettingsSeeded(path: string, libraryRoot: string): void {
  const seeded = ensureSeeded(path, () => JSON.stringify(seedFromEnv(libraryRoot), null, 2) + "\n");
  if (seeded) console.log(`[settings] seeded missing settings at ${path} from environment variables`);
}

/**
 * `libraryRoot` is only used if settings.json doesn't exist yet (the
 * one-time env-var seed's Plex library-root fallback) - once the file
 * exists it's the sole source of truth and this param is ignored.
 */
export function loadSettings(path: string = DEFAULT_SETTINGS_PATH, libraryRoot = ""): Settings {
  ensureSettingsSeeded(path, libraryRoot);
  const raw = readFileSync(path, "utf-8");
  return normalizeSettings(JSON.parse(raw), libraryRoot);
}

export function saveSettings(input: unknown, appLibraryRoot: string, path: string = DEFAULT_SETTINGS_PATH): Settings {
  const settings = normalizeSettings(input, appLibraryRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return settings;
}

export { DEFAULT_SETTINGS_PATH };
