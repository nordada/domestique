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

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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

/**
 * Controls for the generated Plex poster (poster.jpg) each show gets from
 * its uploaded logo. Deliberately separate from accentColor above: that's
 * Domestique's own web-UI theme, this art is displayed inside Plex, a
 * completely different surface. Non-nullable (unlike the optional
 * plex/discord/etc integrations) since this is a built-in feature with
 * sane defaults, not an opt-in external connection. Purely per-show opt-in:
 * a show with no uploaded logo never gets a poster, so there's no fallback
 * text color to configure here.
 */
export interface CoverArtSettings {
  enabled: boolean;
  /** 6-digit hex background fill (or gradient start when backgroundColor2 is set). */
  backgroundColor: string;
  /** Optional 6-digit hex gradient end (top-to-bottom); null = a flat solid-color background. */
  backgroundColor2: string | null;
  /** 0.2-1.0, fraction of the poster's shorter dimension an uploaded logo is scaled to fit within. */
  logoScale: number;
}

export interface Settings {
  plex: PlexConfig | null;
  discord: DiscordConfig | null;
  hotfolder: HotfolderSettings | null;
  /** Optional RPC connection Domestique polls for the header status gauge - unrelated to the webhook Transmission sends this app on torrent completion. */
  transmission: TransmissionConfig | null;
  /** Optional external race indexer site - the header gauge links straight to it, illuminates once it's set, and glows green/red by its own throttled reachability heartbeat (IndexerSettings.checkIntervalMs). */
  indexer: IndexerSettings | null;
  coverArt: CoverArtSettings;
  /** Global pause of automatic processing (Transmission webhook + hot-folder poller). Manual paths (web UI upload, match tester) are unaffected. */
  paused: boolean;
  /** Web UI accent color override (6-digit hex, e.g. "#3b82f6") - primary buttons and the "on" status icons. Null uses the built-in default blue. */
  accentColor: string | null;
  /** How often the web UI re-polls /api/status (header gauges, incl. Transmission's torrent-status glow) in the background, in milliseconds. */
  statusPollIntervalMs: number;
  /** If true, keeps polling /api/status even while the browser tab/window isn't active. Defaults to false (pause when hidden) to avoid needlessly hitting Plex/Transmission while no one's looking. */
  statusPollWhenHidden: boolean;
  /**
   * Optional shared secret for /webhook/torrent-done. That route predates
   * this field and has no other auth (it's meant to be called only by
   * Transmission's own hook script, trusted implicitly on a LAN); this is
   * the retrofit for anyone who exposes the app past their LAN (a reverse
   * proxy, a Cloudflare Tunnel, etc). Null keeps the original open behavior
   * so existing deployments aren't broken by an upgrade. When set, the
   * webhook requires a matching `X-Webhook-Secret` header on every request,
   * checked in constant time (see webui.ts's constantTimeEqual) so a
   * timing attack can't narrow down the secret character by character.
   */
  webhookSecret: string | null;
  /**
   * After this many consecutive failed /ui login attempts (wrong Basic Auth
   * credentials), further attempts are rejected with 429 for a cooldown
   * instead of even being checked; auto-expiring, no restart needed. See
   * webui.ts's login-lockout state for the cooldown itself: it starts at
   * loginLockoutSeconds and doubles on each immediately-repeated trigger up
   * to a fixed internal cap, resetting back to this threshold once a login
   * succeeds.
   */
  loginLockoutThreshold: number;
  /** Base cooldown, in seconds, applied the first time the lockout triggers. */
  loginLockoutSeconds: number;
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
    coverArt: normalizeCoverArt(undefined),
    paused: false,
    accentColor: null,
    statusPollIntervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
    statusPollWhenHidden: false,
    webhookSecret: normalizeWebhookSecret(process.env.WEBHOOK_SECRET),
    loginLockoutThreshold: DEFAULT_LOGIN_LOCKOUT_THRESHOLD,
    loginLockoutSeconds: DEFAULT_LOGIN_LOCKOUT_SECONDS,
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
    coverArt: normalizeCoverArt(raw.coverArt),
    paused: raw.paused === true,
    accentColor: normalizeAccentColor(raw.accentColor),
    statusPollIntervalMs: normalizeStatusPollIntervalMs(raw.statusPollIntervalMs),
    statusPollWhenHidden: raw.statusPollWhenHidden === true,
    webhookSecret: normalizeWebhookSecret(raw.webhookSecret),
    loginLockoutThreshold: normalizeLoginLockoutThreshold(raw.loginLockoutThreshold),
    loginLockoutSeconds: normalizeLoginLockoutSeconds(raw.loginLockoutSeconds),
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

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value.trim());
}

/** Shared by accentColor and the coverArt color fields - falls back when input isn't a valid 6-digit hex string. */
function normalizeHexColor(input: unknown, fallback: string): string {
  return isHexColor(input) ? input.trim() : fallback;
}

function normalizeAccentColor(input: unknown): string | null {
  return isHexColor(input) ? input.trim() : null;
}

function normalizeWebhookSecret(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

const DEFAULT_LOGIN_LOCKOUT_THRESHOLD = 5;
const MIN_LOGIN_LOCKOUT_THRESHOLD = 3;
const MAX_LOGIN_LOCKOUT_THRESHOLD = 20;

function normalizeLoginLockoutThreshold(input: unknown): number {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? parseInt(input, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LOGIN_LOCKOUT_THRESHOLD;
  return Math.min(MAX_LOGIN_LOCKOUT_THRESHOLD, Math.max(MIN_LOGIN_LOCKOUT_THRESHOLD, Math.round(parsed)));
}

const DEFAULT_LOGIN_LOCKOUT_SECONDS = 60;
const MIN_LOGIN_LOCKOUT_SECONDS = 10;
const MAX_LOGIN_LOCKOUT_SECONDS = 3600;

function normalizeLoginLockoutSeconds(input: unknown): number {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? parseInt(input, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LOGIN_LOCKOUT_SECONDS;
  return Math.min(MAX_LOGIN_LOCKOUT_SECONDS, Math.max(MIN_LOGIN_LOCKOUT_SECONDS, Math.round(parsed)));
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

const DEFAULT_COVER_ART_BACKGROUND = "#14213d";
const DEFAULT_COVER_ART_LOGO_SCALE = 0.72;
const MIN_COVER_ART_LOGO_SCALE = 0.2;
const MAX_COVER_ART_LOGO_SCALE = 1.0;

function normalizeCoverArtLogoScale(input: unknown): number {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? parseFloat(input) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_COVER_ART_LOGO_SCALE;
  return Math.min(MAX_COVER_ART_LOGO_SCALE, Math.max(MIN_COVER_ART_LOGO_SCALE, parsed));
}

function normalizeCoverArt(input: unknown): CoverArtSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    backgroundColor: normalizeHexColor(raw.backgroundColor, DEFAULT_COVER_ART_BACKGROUND),
    backgroundColor2: isHexColor(raw.backgroundColor2) ? (raw.backgroundColor2 as string).trim() : null,
    logoScale: normalizeCoverArtLogoScale(raw.logoScale),
  };
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

/**
 * settings.json holds real secrets in plaintext (Plex token, Transmission
 * password, Discord webhook URL, the webhook secret), so it must be readable
 * by the app's own user only: never the default-umask 0644 that would let
 * any other user on the host read it. Applied on every load (not just on
 * write) so files created by earlier versions of the app, which wrote with
 * the default umask, get tightened the first time an upgraded app touches
 * them. Best-effort: a filesystem that doesn't support chmod (some network
 * mounts) shouldn't take the whole app down over it.
 */
const SETTINGS_FILE_MODE = 0o600;

function tightenSettingsPermissions(path: string): void {
  try {
    chmodSync(path, SETTINGS_FILE_MODE);
  } catch (err) {
    console.warn(`[settings] could not tighten permissions on ${path}: ${err}`);
  }
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
  tightenSettingsPermissions(path);
  const raw = readFileSync(path, "utf-8");
  return normalizeSettings(JSON.parse(raw), libraryRoot);
}

export function saveSettings(input: unknown, appLibraryRoot: string, path: string = DEFAULT_SETTINGS_PATH): Settings {
  const settings = normalizeSettings(input, appLibraryRoot);
  mkdirSync(dirname(path), { recursive: true });
  // mode only applies when writeFileSync creates the file; loadSettings's
  // tightenSettingsPermissions covers files that already exist with looser
  // permissions from before this was added.
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf-8", mode: SETTINGS_FILE_MODE });
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
