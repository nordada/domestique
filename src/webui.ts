import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, saveConfig, type ShowsConfigFile } from "./config.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { matchShow } from "./matcher.js";
import { parseName } from "./parser.js";
import { getRecentActivity } from "./activity.js";
import { handleUploadRequest, type ProcessTorrentDone } from "./upload.js";
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

const APP_VERSION = readAppVersion();

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

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths, so bail out rather than
  // short-circuit on length (which would otherwise leak length via timing).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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
    },
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

  if (!isAuthorized(req, opts.webui)) {
    requireAuth(res);
    return true;
  }

  if (url.startsWith("/api/upload/")) {
    if (await handleUploadRequest(req, res, opts, processTorrentDone)) {
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
      sendJson(res, 200, { events: getRecentActivity() });
      return true;
    }

    if (req.method === "GET" && url === "/api/status") {
      const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
      sendJson(res, 200, {
        version: APP_VERSION,
        plex: settings.plex
          ? { enabled: true, sectionId: settings.plex.sectionId, url: settings.plex.url }
          : { enabled: false },
        discord: settings.discord
          ? { enabled: true, hasMention: Boolean(settings.discord.mentionUserId) }
          : { enabled: false },
        hotfolder: settings.hotfolder ? { enabled: true, dir: settings.hotfolder.dir } : { enabled: false },
      });
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
        hotfolder?: { dir?: string; pollIntervalMs?: number; stablePolls?: number };
      };

      // A field only overwrites its stored secret when the caller actually
      // sent it - omitting plexToken/discordWebhookUrl keeps the existing
      // one, since GET /api/settings never echoes the current value back for
      // the frontend to round-trip.
      const current = loadSettings(opts.settingsPath, opts.libraryRoot);
      const plexToken = payload.plexToken !== undefined ? payload.plexToken : (current.plex?.token ?? "");
      const discordWebhookUrl =
        payload.discordWebhookUrl !== undefined ? payload.discordWebhookUrl : (current.discord?.webhookUrl ?? "");

      try {
        const saved = saveSettings(
          {
            plex: { ...payload.plex, token: plexToken },
            discord: { ...payload.discord, webhookUrl: discordWebhookUrl },
            hotfolder: payload.hotfolder,
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
    sendJson(res, 500, { error: String(err) });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
