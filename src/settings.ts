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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureSeeded } from "./fileseed.js";
import { plexConfigFromEnv, type PlexConfig } from "./plex.js";
import { discordConfigFromEnv, type DiscordConfig } from "./discord.js";
import { hotfolderConfigFromEnv, type HotfolderConfig } from "./hotfolder.js";
import type { TransmissionConfig } from "./transmission.js";

export interface HotfolderSettings {
  dir: string;
  pollIntervalMs: number;
  stablePolls: number;
  /** User has acknowledged that hot-folder ingestion moves the original file (into its `processed/` subfolder) instead of leaving it in place to keep seeding. Gates the header gauge's warning glow - see webui.ts's /api/status. */
  acknowledgeNoSeedback: boolean;
}

/** The external site Domestique sources race torrents from (e.g. a private tracker or indexer) - purely a header-gauge bookmark + reachability check, unrelated to how autobrr/Transmission actually pull torrents from it. `checkIntervalMs` throttles how often the header gauge's glow re-probes the site (see webui.ts's /api/status caching) - decoupled from the general statusPollIntervalMs so a fast header refresh doesn't also mean hammering a third-party site. */
export interface IndexerSettings {
  url: string;
  checkIntervalMs: number;
}

export interface Settings {
  plex: PlexConfig | null;
  discord: DiscordConfig | null;
  hotfolder: HotfolderSettings | null;
  /** Optional RPC connection Domestique polls for the header status gauge - unrelated to the webhook Transmission sends this app on torrent completion. */
  transmission: TransmissionConfig | null;
  /** Optional external race indexer site - the header gauge links straight to it, illuminates once it's set, and glows green/red by its own throttled reachability heartbeat (IndexerSettings.checkIntervalMs). */
  indexer: IndexerSettings | null;
  /** Global pause of automatic processing (Transmission webhook + hot-folder poller). Manual paths (web UI upload, match tester) are unaffected. */
  paused: boolean;
  /** Web UI accent color override (6-digit hex, e.g. "#3b82f6") - primary buttons and the "on" status icons. Null uses the built-in default blue. */
  accentColor: string | null;
  /** How often the web UI re-polls /api/status (header gauges, incl. Transmission's torrent-status glow) in the background, in milliseconds. */
  statusPollIntervalMs: number;
  /** If true, keeps polling /api/status even while the browser tab/window isn't active. Defaults to false (pause when hidden) to avoid needlessly hitting Plex/Transmission while no one's looking. */
  statusPollWhenHidden: boolean;
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
      ? {
          dir: hotfolder.dir,
          pollIntervalMs: hotfolder.pollIntervalMs,
          stablePolls: hotfolder.stablePolls,
          acknowledgeNoSeedback: false,
        }
      : null,
    // No env-var seeding for either of these - both are new, purely
    // optional status checks with no prior deployment relying on env vars
    // for them, unlike Plex/Discord/hot-folder which predate settings.json
    // entirely.
    transmission: null,
    indexer: null,
    paused: false,
    accentColor: null,
    statusPollIntervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
    statusPollWhenHidden: false,
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
    transmission: normalizeTransmission(raw.transmission),
    indexer: normalizeIndexer(raw.indexer),
    paused: raw.paused === true,
    accentColor: normalizeAccentColor(raw.accentColor),
    statusPollIntervalMs: normalizeStatusPollIntervalMs(raw.statusPollIntervalMs),
    statusPollWhenHidden: raw.statusPollWhenHidden === true,
  };
}

const DEFAULT_STATUS_POLL_INTERVAL_MS = 20000;
const MIN_STATUS_POLL_INTERVAL_MS = 5000;
const MAX_STATUS_POLL_INTERVAL_MS = 600000; // 10 minutes

/** Clamped rather than left unbounded - a too-small interval would hammer Plex/Transmission, and a bad/huge value (or NaN from a stray string) would silently look like polling had stopped. */
function normalizeStatusPollIntervalMs(input: unknown): number {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? parseInt(input, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_STATUS_POLL_INTERVAL_MS;
  return Math.min(MAX_STATUS_POLL_INTERVAL_MS, Math.max(MIN_STATUS_POLL_INTERVAL_MS, Math.round(parsed)));
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function normalizeAccentColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
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

function normalizeTransmission(input: unknown): TransmissionConfig | null {
  if (!input || typeof input !== "object") return null;
  const { url, username, password } = input as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) return null;

  return {
    url: url.replace(/\/$/, ""),
    username: typeof username === "string" && username.trim() ? username : undefined,
    password: typeof password === "string" && password ? password : undefined,
  };
}

export const DEFAULT_INDEXER_CHECK_INTERVAL_MS = 300000; // 5 minutes
const MIN_INDEXER_CHECK_INTERVAL_MS = 30000; // 30 seconds - a floor, not a target; keeps a fat-fingered value from hammering a third-party site
const MAX_INDEXER_CHECK_INTERVAL_MS = 3600000; // 1 hour

function normalizeIndexerCheckIntervalMs(input: unknown): number {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? parseInt(input, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_INDEXER_CHECK_INTERVAL_MS;
  return Math.min(MAX_INDEXER_CHECK_INTERVAL_MS, Math.max(MIN_INDEXER_CHECK_INTERVAL_MS, Math.round(parsed)));
}

function normalizeIndexer(input: unknown): IndexerSettings | null {
  if (!input || typeof input !== "object") return null;
  const { url, checkIntervalMs } = input as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) return null;
  return { url: url.trim(), checkIntervalMs: normalizeIndexerCheckIntervalMs(checkIntervalMs) };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHotfolder(input: unknown): HotfolderSettings | null {
  if (!input || typeof input !== "object") return null;
  const { dir, pollIntervalMs, stablePolls, acknowledgeNoSeedback } = input as Record<string, unknown>;
  if (typeof dir !== "string" || !dir.trim()) return null;

  return {
    dir,
    pollIntervalMs: normalizePositiveInt(pollIntervalMs, 60000),
    stablePolls: normalizePositiveInt(stablePolls, 3),
    acknowledgeNoSeedback: acknowledgeNoSeedback === true,
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

/**
 * Flips just the `paused` flag without touching Plex/Discord/hot-folder
 * settings - the header switch's dedicated write path, separate from the
 * full-form save on the Settings page.
 */
export function setPaused(
  paused: boolean,
  appLibraryRoot: string,
  path: string = DEFAULT_SETTINGS_PATH
): Settings {
  const current = loadSettings(path, appLibraryRoot);
  return saveSettings({ ...current, paused }, appLibraryRoot, path);
}

export { DEFAULT_SETTINGS_PATH };
