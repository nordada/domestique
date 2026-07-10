import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, saveConfig, type ShowsConfigFile } from "./config.js";
import { matchShow } from "./matcher.js";
import { parseName } from "./parser.js";
import { getRecentActivity } from "./activity.js";
import { hotfolderConfigFromEnv } from "./hotfolder.js";
import type { ServerOptions } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, "..", "public", "index.html");

export interface WebUiConfig {
  password: string;
}

export function webUiConfigFromEnv(): WebUiConfig | null {
  const password = process.env.WEBUI_PASSWORD;
  if (!password) return null;
  return { password };
}

/**
 * Constant-time password check against the decoded password from an HTTP
 * Basic Auth header (username is accepted but never checked — this is a
 * single shared-password gate, not a multi-user login).
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
  const password = colonIndex === -1 ? decoded : decoded.slice(colonIndex + 1);

  const a = Buffer.from(password);
  const b = Buffer.from(webui.password);
  // timingSafeEqual throws on mismatched lengths, so pad rather than
  // short-circuit on length (which would leak length via timing).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
 * Handles any request under /ui or /api/. Returns false if the request path
 * doesn't belong to the web UI at all, so callers can fall through to their
 * own routing. Fails CLOSED (503) rather than open when WEBUI_PASSWORD isn't
 * configured — unlike the Plex/Discord/hot-folder integrations, this exposes
 * read/write access to config over HTTP, so "unconfigured" must not mean
 * "reachable without a password."
 */
export async function handleWebUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions
): Promise<boolean> {
  const url = req.url ?? "";
  if (url !== "/ui" && !url.startsWith("/api/")) return false;

  if (!opts.webui) {
    sendJson(res, 503, { error: "web UI disabled — set WEBUI_PASSWORD in .env to enable" });
    return true;
  }

  if (!isAuthorized(req, opts.webui)) {
    requireAuth(res);
    return true;
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

    if (req.method === "GET" && url === "/api/shows") {
      const config = loadConfig(opts.configPath);
      sendJson(res, 200, config);
      return true;
    }

    if (req.method === "PUT" && url === "/api/shows") {
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
      // saveConfig — that's what makes this a safe, non-destructive preview.
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
      const hotfolder = hotfolderConfigFromEnv();
      sendJson(res, 200, {
        plex: opts.plex ? { enabled: true, sectionId: opts.plex.sectionId, url: opts.plex.url } : { enabled: false },
        discord: opts.discord
          ? { enabled: true, hasMention: Boolean(opts.discord.mentionUserId) }
          : { enabled: false },
        hotfolder: hotfolder ? { enabled: true, dir: hotfolder.dir } : { enabled: false },
      });
      return true;
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
