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

import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, saveConfig, type ShowsConfigFile } from "./config.js";
import {
  loadSettings,
  saveSettings,
  setPaused,
  DEFAULT_INDEXER_CHECK_INTERVAL_MS,
  type Settings,
  type IndexerSettings,
} from "./settings.js";
import { matchShow } from "./matcher.js";
import { parseName } from "./parser.js";
import { getRecentActivity, recordActivity } from "./activity.js";
import { handleUploadRequest, sanitizeName, type ProcessTorrentDone } from "./upload.js";
import { handleCoverArtRequest } from "./coverArt.js";
import { checkPlexLive, plexLibraryUrl } from "./plex.js";
import {
  getTransmissionTorrentSummary,
  addTorrentToTransmission,
  pollTorrentAdded,
  transmissionWebUrl,
} from "./transmission.js";
import { checkIndexerLive } from "./indexer.js";
import { sendDiscordNotification } from "./discord.js";
import { readBody, readBodyBuffer, BodyTooLargeError, TORRENT_BODY_LIMIT_BYTES } from "./body.js";
import type { ServerOptions } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, "..", "public", "index.html");
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

function readAppVersion(): string {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Best-effort check that the downloads/seeding share is actually mounted and readable - used only for the header status gauge, never to gate real processing (a webhook/hot-folder file that fails to resolve just fails normally with its own error). */
function isDownloadsReachable(downloadsPath: string): boolean {
  try {
    return statSync(downloadsPath).isDirectory();
  } catch {
    return false;
  }
}

const APP_VERSION = readAppVersion();

/**
 * Throttles the indexer's reachability probe to IndexerSettings.checkIntervalMs,
 * independent of how often the browser itself polls /api/status (which can be
 * every few seconds) - otherwise every header refresh re-probes a third-party
 * site and a single flaky response flips the glow before the next poll fixes
 * it. Keyed by settingsPath so concurrent app instances (notably parallel
 * tests, each with their own scratch settings file) never share a cache entry.
 */
const indexerLiveCache = new Map<string, { url: string; checkedAt: number; live: boolean }>();

async function getIndexerLive(settingsPath: string, indexer: IndexerSettings): Promise<boolean> {
  const cached = indexerLiveCache.get(settingsPath);
  const now = Date.now();
  if (cached && cached.url === indexer.url && now - cached.checkedAt < indexer.checkIntervalMs) {
    return cached.live;
  }
  const live = await checkIndexerLive(indexer);
  indexerLiveCache.set(settingsPath, { url: indexer.url, checkedAt: now, live });
  return live;
}

export interface WebUiConfig {
  password: string;
  /** Optional required username. If unset, any username is accepted (password-only gate). */
  username?: string;
}

export function webUiConfigFromEnv(): WebUiConfig | null {
  const password = process.env.WEBUI_PASSWORD;
  if (!password) return null;
  const username = process.env.WEBUI_USER || undefined;
  return { password, username };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths, so bail out rather than
  // short-circuit on length (which would otherwise leak length via timing).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Basic Auth has no brute-force protection of its own: this is that
// protection, auto-expiring rather than needing a restart to clear (unlike
// a hard lockout, which would just hand an attacker a free way to lock the
// real owner out with a handful of bad requests). The cooldown starts at
// Settings.loginLockoutSeconds once loginLockoutThreshold consecutive
// failures land, and doubles on each immediately-repeated trigger up to
// LOGIN_LOCKOUT_MAX_SECONDS (a fixed ceiling, not itself configurable, so a
// sustained attack keeps getting slower rather than growing unbounded). A
// successful login resets it back to the base. Keyed by settingsPath so
// concurrent app instances (notably parallel tests) never share state.
export const LOGIN_LOCKOUT_MAX_SECONDS = 1800; // 30 minutes

interface LoginLockoutState {
  failedAttempts: number;
  /** Epoch ms; 0 means not currently locked out. */
  lockedUntil: number;
  /** How many times the lockout itself has triggered in a row, without an intervening successful login: drives the doubling. */
  consecutiveLockouts: number;
}

const loginLockoutByPath = new Map<string, LoginLockoutState>();

function getLoginLockoutState(settingsPath: string): LoginLockoutState {
  let state = loginLockoutByPath.get(settingsPath);
  if (!state) {
    state = { failedAttempts: 0, lockedUntil: 0, consecutiveLockouts: 0 };
    loginLockoutByPath.set(settingsPath, state);
  }
  return state;
}

/** Pure cooldown math, pulled out of the request-handling flow so it's testable without any real waiting. */
export function nextLockoutCooldownSeconds(baseSeconds: number, consecutiveLockouts: number): number {
  return Math.min(baseSeconds * 2 ** consecutiveLockouts, LOGIN_LOCKOUT_MAX_SECONDS);
}

// CSRF guard for the state-changing routes: a browser that has cached Basic
// Auth credentials for this host will happily attach them to a request a
// hostile page triggers, and simple POSTs don't require a CORS preflight the
// server would never answer. Browsers always send Origin on cross-origin
// mutating requests, so "Origin present and not our own host" is exactly the
// cross-site case; requests with no Origin at all (curl, same-origin
// navigations, Transmission's hook script) are untouched. The webhook route
// is deliberately outside this guard: it's machine-to-machine, carries no
// Origin, and is already secret-gated.
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    // Includes the literal "null" a sandboxed iframe or data: page sends -
    // unattributable, so treated as cross-origin.
    return true;
  }
}

/**
 * Constant-time check of the decoded credentials from an HTTP Basic Auth
 * header. Username is only checked when WEBUI_USER is configured - leaving
 * it unset keeps the original password-only gate (any username accepted).
 */
function isAuthorized(req: IncomingMessage, webui: WebUiConfig): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
  } catch {
    return false;
  }

  const colonIndex = decoded.indexOf(":");
  const username = colonIndex === -1 ? "" : decoded.slice(0, colonIndex);
  const password = colonIndex === -1 ? decoded : decoded.slice(colonIndex + 1);

  if (webui.username && !constantTimeEqual(username, webui.username)) return false;
  return constantTimeEqual(password, webui.password);
}

function requireAuth(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Basic realm="Domestique"',
  });
  res.end(JSON.stringify({ error: "authentication required" }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Shapes Settings for the browser with secrets masked - the Plex token and
 * Discord webhook URL are never sent back once set (only whether one is
 * set), so a stolen response or a screen-share can't leak either credential.
 */
function maskSettings(settings: Settings) {
  return {
    plex: {
      url: settings.plex?.url ?? "",
      sectionId: settings.plex?.sectionId ?? "",
      libraryRoot: settings.plex?.libraryRoot ?? "",
      tokenSet: Boolean(settings.plex?.token),
    },
    discord: {
      mentionUserId: settings.discord?.mentionUserId ?? "",
      webhookUrlSet: Boolean(settings.discord?.webhookUrl),
    },
    hotfolder: {
      dir: settings.hotfolder?.dir ?? "",
      pollIntervalMs: settings.hotfolder?.pollIntervalMs ?? 60000,
      stablePolls: settings.hotfolder?.stablePolls ?? 3,
      acknowledgeNoSeedback: settings.hotfolder?.acknowledgeNoSeedback ?? false,
    },
    transmission: {
      url: settings.transmission?.url ?? "",
      username: settings.transmission?.username ?? "",
      passwordSet: Boolean(settings.transmission?.password),
    },
    indexer: {
      url: settings.indexer?.url ?? "",
      checkIntervalMs: settings.indexer?.checkIntervalMs ?? DEFAULT_INDEXER_CHECK_INTERVAL_MS,
    },
    // No secrets in this section, so the whole object is returned as-is.
    coverArt: settings.coverArt,
    paused: settings.paused,
    accentColor: settings.accentColor ?? "",
    statusPollIntervalMs: settings.statusPollIntervalMs,
    statusPollWhenHidden: settings.statusPollWhenHidden,
    webhookSecretSet: Boolean(settings.webhookSecret),
    loginLockoutThreshold: settings.loginLockoutThreshold,
    loginLockoutSeconds: settings.loginLockoutSeconds,
  };
}

/**
 * Handles any request under /ui or /api/. Returns false if the request path
 * doesn't belong to the web UI at all, so callers can fall through to their
 * own routing. Fails CLOSED (503) rather than open when WEBUI_PASSWORD isn't
 * configured - unlike the Plex/Discord/hot-folder integrations, this exposes
 * read/write access to config over HTTP, so "unconfigured" must not mean
 * "reachable without a password."
 */
export async function handleWebUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  processTorrentDone: ProcessTorrentDone
): Promise<boolean> {
  const url = req.url ?? "";
  if (url !== "/ui" && !url.startsWith("/api/")) return false;

  if (!opts.webui) {
    sendJson(res, 503, { error: "web UI disabled - set WEBUI_PASSWORD in .env to enable" });
    return true;
  }

  // Checked before auth on purpose: the attack this stops is a request that
  // WOULD pass auth (the victim's own browser attaching cached credentials),
  // and rejecting early keeps forged requests out of the login lockout math.
  if (MUTATING_METHODS.has(req.method ?? "") && isCrossOrigin(req)) {
    sendJson(res, 403, { error: "cross-origin requests are not allowed" });
    return true;
  }

  const lockout = getLoginLockoutState(opts.settingsPath);
  const now = Date.now();
  if (lockout.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((lockout.lockedUntil - now) / 1000);
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) });
    res.end(JSON.stringify({ error: `too many failed login attempts, try again in ${retryAfterSeconds}s` }));
    return true;
  }

  if (!isAuthorized(req, opts.webui)) {
    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    lockout.failedAttempts++;
    if (lockout.failedAttempts >= settings.loginLockoutThreshold) {
      const cooldownSeconds = nextLockoutCooldownSeconds(settings.loginLockoutSeconds, lockout.consecutiveLockouts);
      lockout.lockedUntil = now + cooldownSeconds * 1000;
      lockout.consecutiveLockouts++;
      lockout.failedAttempts = 0;
      // Fired once per trigger, not on every subsequent 429 while still
      // locked out (this whole block only runs the moment the threshold is
      // crossed), so a sustained attack doesn't spam the channel.
      if (settings.discord) {
        // Behind a tunnel or reverse proxy this is the proxy's own address,
        // not the attacker's. The forwarded-for style headers that would
        // carry the real one are spoofable unless direct origin access is
        // blocked, so this deliberately reports the socket's honest (if
        // less useful) address rather than trusting a header.
        const from = req.socket.remoteAddress ?? "unknown address";
        sendDiscordNotification(
          settings.discord,
          `🔒 Login lockout triggered: ${settings.loginLockoutThreshold} failed /ui login attempts from ${from}, locked out for ${cooldownSeconds}s.`,
          { mention: true }
        ).catch((notifyErr) => console.warn(`[discord] failed to send lockout notification: ${notifyErr}`));
      }
    }
    requireAuth(res);
    return true;
  }
  lockout.failedAttempts = 0;
  lockout.consecutiveLockouts = 0;

  if (url.startsWith("/api/upload/")) {
    if (await handleUploadRequest(req, res, opts, processTorrentDone)) {
      return true;
    }
  }

  if (url.startsWith("/api/cover-art/")) {
    if (await handleCoverArtRequest(req, res, opts)) {
      return true;
    }
  }

  try {
    if (req.method === "GET" && url === "/ui") {
      if (!existsSync(INDEX_HTML_PATH)) {
        sendJson(res, 500, { error: `public/index.html not found at ${INDEX_HTML_PATH}` });
        return true;
      }
      const html = readFileSync(INDEX_HTML_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    if (req.method === "GET" && url === "/api/events") {
      const config = loadConfig(opts.configPath);
      sendJson(res, 200, config);
      return true;
    }

    if (req.method === "PUT" && url === "/api/events") {
      const body = await readBody(req);
      const payload = JSON.parse(body) as ShowsConfigFile;
      try {
        saveConfig(payload, opts.configPath);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return true;
    }

    if (req.method === "POST" && url === "/api/match-test") {
      const body = await readBody(req);
      const { name } = JSON.parse(body) as { name?: string };
      if (!name) {
        sendJson(res, 400, { error: "body must include name" });
        return true;
      }
      const parsed = parseName(name);
      // A fresh config load whose auto-create mutation (matchShow pushes a
      // new show into it when nothing matches) is never persisted via
      // saveConfig - that's what makes this a safe, non-destructive preview.
      const config = loadConfig(opts.configPath);
      const match = matchShow(parsed, config);
      sendJson(res, 200, {
        parsed: {
          raw: parsed.raw,
          year: parsed.year,
          yearWasExplicit: parsed.yearWasExplicit,
          stageNum: parsed.stageNum,
          partNum: parsed.partNum,
          partTotal: parsed.partTotal,
          resolution: parsed.resolution,
          broadcaster: parsed.broadcaster,
          isHighlights: parsed.isHighlights,
        },
        match: {
          showId: match.show.id,
          folderName: match.show.folderName,
          type: match.show.type,
          isHighlights: Boolean(match.show.isHighlights),
          autoCreated: match.autoCreated,
          specificity: match.specificity,
          matchedTokens: [...match.matchedTokens],
        },
      });
      return true;
    }

    if (req.method === "GET" && url === "/api/activity") {
      sendJson(res, 200, { events: getRecentActivity(opts.activityPath) });
      return true;
    }

    if (req.method === "POST" && url.startsWith("/api/transmission/add-torrent")) {
      const rawName = new URL(req.url ?? "", "http://internal").searchParams.get("name") || "upload.torrent";
      let name: string;
      try {
        name = sanitizeName(rawName);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
        return true;
      }

      const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
      if (!settings.transmission) {
        const message = "Transmission isn't configured - set its RPC URL in Settings before adding torrents.";
        recordActivity(
          {
            timestamp: new Date().toISOString(),
            torrentName: name,
            lines: [`❌ ${message}`],
            reviewWorthy: true,
          },
          opts.activityPath
        );
        sendJson(res, 400, { ok: false, error: message });
        return true;
      }

      const body = await readBodyBuffer(req, TORRENT_BODY_LIMIT_BYTES);
      try {
        const added = await addTorrentToTransmission(settings.transmission, body.toString("base64"));
        // torrent-add returning success already means Transmission accepted
        // it, but polling torrent-get confirms it's actually registered and
        // gets a fresher error/status than the add response carries.
        const confirmed = await pollTorrentAdded(settings.transmission, added.id);

        const lines = [
          added.duplicate
            ? `⚠️ "${added.name}" was already in Transmission (duplicate) - not a new download.`
            : `✅ "${added.name}" added to Transmission.`,
        ];
        if (confirmed) {
          lines.push(
            confirmed.error
              ? `⚠️ Confirmed by Transmission, but it's reporting an error: ${confirmed.errorString}`
              : "Confirmed by Transmission."
          );
        } else {
          lines.push("⚠️ Added, but could not confirm Transmission registered it after polling - check Transmission directly.");
        }

        recordActivity(
          {
            timestamp: new Date().toISOString(),
            torrentName: added.name,
            lines,
            reviewWorthy: added.duplicate || !confirmed || Boolean(confirmed?.error),
          },
          opts.activityPath
        );
        sendJson(res, 200, { ok: true, added, confirmed: Boolean(confirmed), status: confirmed });
      } catch (err) {
        const message = `Failed to add torrent to Transmission: ${err}`;
        recordActivity(
          {
            timestamp: new Date().toISOString(),
            torrentName: name,
            lines: [`❌ ${message}`],
            reviewWorthy: true,
          },
          opts.activityPath
        );
        sendJson(res, 500, { ok: false, error: message });
      }
      return true;
    }

    if (req.method === "GET" && url === "/api/status") {
      const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
      // Live-probed in parallel so one slow/unreachable service doesn't
      // multiply the page's load time by the number of integrations. A
      // successful torrent summary fetch doubles as the Transmission
      // liveness check - one RPC round-trip instead of two. The indexer
      // check goes through getIndexerLive's own cache instead of a raw
      // probe here - see its comment for why (a third-party site polled as
      // often as this endpoint itself, which can be every few seconds,
      // flickers its glow between green/red on ordinary network noise).
      const [plexIdentity, transmissionSummary, indexerLive] = await Promise.all([
        settings.plex ? checkPlexLive(settings.plex) : Promise.resolve({ live: false, machineIdentifier: null }),
        settings.transmission ? getTransmissionTorrentSummary(settings.transmission) : Promise.resolve(null),
        settings.indexer ? getIndexerLive(opts.settingsPath, settings.indexer) : Promise.resolve(false),
      ]);
      sendJson(res, 200, {
        version: APP_VERSION,
        plex: settings.plex
          ? {
              enabled: true,
              sectionId: settings.plex.sectionId,
              url: settings.plex.url,
              live: plexIdentity.live,
              // Only buildable once we've actually reached Plex this poll and
              // it handed back a machineIdentifier - there's no other source
              // for it, so a currently-unreachable Plex just has no link
              // (the gauge falls back to opening Settings instead, same as
              // when Plex isn't configured at all).
              webUrl: plexIdentity.machineIdentifier
                ? plexLibraryUrl(settings.plex, plexIdentity.machineIdentifier)
                : null,
            }
          : { enabled: false, live: false, webUrl: null },
        discord: settings.discord
          ? { enabled: true, hasMention: Boolean(settings.discord.mentionUserId) }
          : { enabled: false, hasMention: false },
        hotfolder: settings.hotfolder
          ? { enabled: true, dir: settings.hotfolder.dir, acknowledgeNoSeedback: settings.hotfolder.acknowledgeNoSeedback }
          : { enabled: false },
        transmission: settings.transmission
          ? {
              enabled: true,
              url: settings.transmission.url,
              live: transmissionSummary !== null,
              torrents: transmissionSummary,
              webUrl: transmissionWebUrl(settings.transmission),
            }
          : { enabled: false, live: false, torrents: null, webUrl: null },
        indexer: settings.indexer
          ? { enabled: true, url: settings.indexer.url, live: indexerLive }
          : { enabled: false, live: false },
        downloads: { reachable: isDownloadsReachable(opts.downloadsPath) },
        paused: settings.paused,
      });
      return true;
    }

    if (req.method === "PUT" && url === "/api/paused") {
      const body = await readBody(req);
      const { paused } = JSON.parse(body) as { paused?: boolean };
      if (typeof paused !== "boolean") {
        sendJson(res, 400, { error: "body must include a boolean paused" });
        return true;
      }
      const saved = setPaused(paused, opts.libraryRoot, opts.settingsPath);
      sendJson(res, 200, { ok: true, paused: saved.paused });
      return true;
    }

    if (req.method === "GET" && url === "/api/settings") {
      const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
      sendJson(res, 200, maskSettings(settings));
      return true;
    }

    if (req.method === "PUT" && url === "/api/settings") {
      const body = await readBody(req);
      const payload = JSON.parse(body) as {
        plex?: { url?: string; sectionId?: string; libraryRoot?: string };
        plexToken?: string;
        discord?: { mentionUserId?: string };
        discordWebhookUrl?: string;
        hotfolder?: { dir?: string; pollIntervalMs?: number; stablePolls?: number; acknowledgeNoSeedback?: boolean };
        transmission?: { url?: string; username?: string };
        transmissionPassword?: string;
        indexer?: { url?: string; checkIntervalMs?: number };
        coverArt?: {
          enabled?: boolean;
          backgroundColor?: string;
          backgroundColor2?: string;
          logoScale?: number;
        };
        accentColor?: string;
        statusPollIntervalMs?: number;
        statusPollWhenHidden?: boolean;
        webhookSecret?: string;
        loginLockoutThreshold?: number;
        loginLockoutSeconds?: number;
      };

      // A field only overwrites its stored secret when the caller actually
      // sent it: omitting plexToken/discordWebhookUrl/transmissionPassword/
      // webhookSecret keeps the existing one, since GET /api/settings never
      // echoes the current value back for the frontend to round-trip.
      const current = loadSettings(opts.settingsPath, opts.libraryRoot);
      const plexToken = payload.plexToken !== undefined ? payload.plexToken : (current.plex?.token ?? "");
      const discordWebhookUrl =
        payload.discordWebhookUrl !== undefined ? payload.discordWebhookUrl : (current.discord?.webhookUrl ?? "");
      const transmissionPassword =
        payload.transmissionPassword !== undefined
          ? payload.transmissionPassword
          : (current.transmission?.password ?? "");
      const webhookSecret =
        payload.webhookSecret !== undefined ? payload.webhookSecret : (current.webhookSecret ?? "");

      try {
        const saved = saveSettings(
          {
            plex: { ...payload.plex, token: plexToken },
            discord: { ...payload.discord, webhookUrl: discordWebhookUrl },
            hotfolder: payload.hotfolder,
            transmission: { ...payload.transmission, password: transmissionPassword },
            indexer: payload.indexer,
            coverArt: payload.coverArt,
            paused: current.paused,
            accentColor: payload.accentColor,
            statusPollIntervalMs: payload.statusPollIntervalMs,
            statusPollWhenHidden: payload.statusPollWhenHidden,
            webhookSecret,
            loginLockoutThreshold: payload.loginLockoutThreshold,
            loginLockoutSeconds: payload.loginLockoutSeconds,
          },
          opts.libraryRoot,
          opts.settingsPath
        );
        sendJson(res, 200, { ok: true, ...maskSettings(saved) });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return true;
    }
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Connection: close tells a client mid-send to stop; its message
      // carries no internals, so echoing it is fine.
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: err.message }));
      return true;
    }
    // Detail stays server-side only: a raw String(err) can leak internal
    // filesystem paths (e.g. an ENOENT's full path) to the client, which
    // matters now that the app can be internet-exposed.
    console.error(`[webui] error handling ${req.method} ${url}:`, err);
    sendJson(res, 500, { error: "internal error" });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
