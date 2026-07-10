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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { loadSettings, DEFAULT_SETTINGS_PATH } from "./settings.js";
import { matchShow } from "./matcher.js";
import { buildDestination } from "./namer.js";
import { copyIntoLibrary, resolveDynamicEpisode, resolveSourceItems } from "./fileops.js";
import { refreshPlexFolder } from "./plex.js";
import { sendDiscordNotification } from "./discord.js";
import { recordActivity } from "./activity.js";
import { webUiConfigFromEnv, handleWebUiRequest, type WebUiConfig } from "./webui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAVICON_PATH = join(__dirname, "..", "public", "favicon.svg");
const ICONS_DIR = join(__dirname, "..", "public", "icons");
// Allow-listed rather than an open static-file route off req.url, so a
// crafted path can't escape ICONS_DIR - same "unauthenticated but not
// attacker-controlled" trust level as the favicon route below.
const ICON_FILES = new Set(["plex.svg", "discord.svg", "hotfolder.svg", "transmission.svg"]);

export interface ServerOptions {
  port: number;
  libraryRoot: string;
  configPath: string;
  settingsPath: string;
  webui: WebUiConfig | null;
}

export interface TorrentDonePayload {
  dir: string;
  name: string;
  id?: string;
  hash?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function handleTorrentDone(payload: TorrentDonePayload, opts: ServerOptions) {
  const results: Array<{
    sourceFile: string;
    status: string;
    destPath?: string;
    warning?: string | null;
  }> = [];

  const config = loadConfig(opts.configPath);
  const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
  let configDirty = false;
  const changedFolders = new Set<string>();
  const summaryLines: string[] = [];
  let reviewWorthy = false;

  const items = await resolveSourceItems(payload.dir, payload.name);
  console.log(`[torrent-done] "${payload.name}" -> ${items.length} file(s) to process`);

  for (const item of items) {
    const match = matchShow(item.parsed, config);
    if (match.autoCreated) {
      configDirty = true;
      reviewWorthy = true;
      console.warn(
        `[auto-create] No config match for "${item.parsed.raw}" -> created show "${match.show.id}" (folder "${match.show.folderName}"). Review config/events.json.`
      );
      summaryLines.push(`⚠️ auto-created show "${match.show.id}" for "${item.parsed.raw}" - review config/events.json`);
    }

    const plan = await buildDestination(
      match.show,
      item.parsed,
      item.ext,
      match.matchedTokens,
      (destDir, title) => resolveDynamicEpisode(opts.libraryRoot, destDir, title)
    );

    if (plan.warning) {
      console.warn(`[namer] ${plan.warning}`);
      reviewWorthy = true;
      summaryLines.push(`⚠️ ${plan.warning}`);
    }

    const outcome = await copyIntoLibrary(
      item.sourceFile,
      opts.libraryRoot,
      plan.destDir,
      plan.destFilename,
      plan.episode,
      item.parsed.resolution,
      item.parsed.broadcaster
    );

    if (outcome.status === "copied" && outcome.warning) {
      console.warn(`[quality] ${outcome.warning}`);
      reviewWorthy = true;
      summaryLines.push(`⚠️ ${outcome.warning}`);
    }

    if (outcome.status === "copied") {
      changedFolders.add(join(opts.libraryRoot, plan.destDir));
      summaryLines.push(`✅ ${plan.destDir}/${plan.destFilename}`);
    } else {
      summaryLines.push(`⏭️ skipped "${item.sourceFile}": ${outcome.reason}`);
    }

    console.log(
      `[${outcome.status}] ${item.sourceFile} -> ${plan.destDir}/${plan.destFilename}`
    );

    results.push({
      sourceFile: item.sourceFile,
      status: outcome.status,
      destPath: outcome.destPath,
      warning: plan.warning ?? (outcome.status === "copied" ? outcome.warning : outcome.reason),
    });
  }

  if (configDirty) {
    saveConfig(config, opts.configPath);
  }

  if (settings.plex && changedFolders.size > 0) {
    for (const folder of changedFolders) {
      try {
        await refreshPlexFolder(settings.plex, opts.libraryRoot, folder);
        console.log(`[plex] refreshed "${folder}"`);
      } catch (err) {
        console.warn(`[plex] failed to refresh "${folder}": ${err}`);
        reviewWorthy = true;
        summaryLines.push(`⚠️ Plex refresh failed for "${folder}": ${err}`);
      }
    }
  }

  if (settings.discord) {
    const message = [`**${payload.name}** - ${items.length} file(s)`, ...summaryLines].join("\n");
    try {
      await sendDiscordNotification(settings.discord, message, { mention: reviewWorthy });
    } catch (err) {
      console.warn(`[discord] failed to send notification: ${err}`);
    }
  }

  recordActivity({
    timestamp: new Date().toISOString(),
    torrentName: payload.name,
    lines: summaryLines,
    reviewWorthy,
  });

  return results;
}

export function createApp(opts: ServerOptions) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "GET" && req.url === "/favicon.svg") {
      try {
        const svg = readFileSync(FAVICON_PATH, "utf-8");
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end(svg);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "favicon not found" }));
      }
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/icons/") && ICON_FILES.has(req.url.slice("/icons/".length))) {
      try {
        const svg = readFileSync(join(ICONS_DIR, req.url.slice("/icons/".length)), "utf-8");
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end(svg);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "icon not found" }));
      }
      return;
    }

    if (await handleWebUiRequest(req, res, opts, handleTorrentDone)) {
      return;
    }

    if (req.method === "POST" && req.url === "/webhook/torrent-done") {
      try {
        const body = await readBody(req);
        const payload = JSON.parse(body) as TorrentDonePayload;
        if (!payload.dir || !payload.name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload must include dir and name" }));
          return;
        }
        if (loadSettings(opts.settingsPath, opts.libraryRoot).paused) {
          console.log(`[webhook] paused - skipping "${payload.name}"`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, paused: true, results: [] }));
          return;
        }
        const results = await handleTorrentDone(payload, opts);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (err) {
        console.error("[webhook] error handling torrent-done:", err);
        const discord = loadSettings(opts.settingsPath, opts.libraryRoot).discord;
        if (discord) {
          sendDiscordNotification(discord, `❌ webhook error handling torrent-done: ${err}`, {
            mention: true,
          }).catch((notifyErr) => console.warn(`[discord] failed to send notification: ${notifyErr}`));
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // Node's default requestTimeout (5 minutes) would kill a large web-UI
  // upload (src/upload.ts) partway through on anything less than a very
  // fast connection. Disabling it is reasonable here since this is a
  // password-gated LAN tool, not a public endpoint where slowloris-style
  // abuse is a real concern.
  server.requestTimeout = 0;

  return server;
}

export function optionsFromEnv(): ServerOptions {
  // "|| " rather than "?? " deliberately: docker-compose's "${VAR}" expands
  // to an empty string (not an absent var) when VAR isn't set in .env, so
  // "??" would never fall through and parseInt("", 10) would silently
  // produce NaN. Same bug class that caused a real incident in
  // hotfolderConfigFromEnv (see src/hotfolder.ts) - fixed here too even
  // though PORT/CONFIG_PATH are normally always set, since NaN/empty here
  // is just as dangerous if .env is ever incomplete.
  const port = parseInt(process.env.PORT || "8420", 10);
  const libraryRoot = process.env.LIBRARY_ROOT;
  const configPath = process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const settingsPath = process.env.SETTINGS_PATH || DEFAULT_SETTINGS_PATH;

  if (!libraryRoot) {
    throw new Error("LIBRARY_ROOT environment variable is required (Plex library root path)");
  }

  const webui = webUiConfigFromEnv();

  return { port, libraryRoot, configPath, settingsPath, webui };
}
