import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { matchShow } from "./matcher.js";
import { buildDestination } from "./namer.js";
import { copyIntoLibrary, resolveDynamicEpisode, resolveSourceItems } from "./fileops.js";
import { plexConfigFromEnv, refreshPlexFolder, type PlexConfig } from "./plex.js";
import { discordConfigFromEnv, sendDiscordNotification, type DiscordConfig } from "./discord.js";
import { recordActivity } from "./activity.js";
import { webUiConfigFromEnv, handleWebUiRequest, type WebUiConfig } from "./webui.js";

export interface ServerOptions {
  port: number;
  libraryRoot: string;
  configPath: string;
  plex: PlexConfig | null;
  discord: DiscordConfig | null;
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
      summaryLines.push(`⚠️ auto-created show "${match.show.id}" for "${item.parsed.raw}" — review config/events.json`);
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

  if (opts.plex && changedFolders.size > 0) {
    for (const folder of changedFolders) {
      try {
        await refreshPlexFolder(opts.plex, opts.libraryRoot, folder);
        console.log(`[plex] refreshed "${folder}"`);
      } catch (err) {
        console.warn(`[plex] failed to refresh "${folder}": ${err}`);
        reviewWorthy = true;
        summaryLines.push(`⚠️ Plex refresh failed for "${folder}": ${err}`);
      }
    }
  }

  if (opts.discord) {
    const message = [`**${payload.name}** — ${items.length} file(s)`, ...summaryLines].join("\n");
    try {
      await sendDiscordNotification(opts.discord, message, { mention: reviewWorthy });
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
        const results = await handleTorrentDone(payload, opts);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (err) {
        console.error("[webhook] error handling torrent-done:", err);
        if (opts.discord) {
          sendDiscordNotification(opts.discord, `❌ webhook error handling torrent-done: ${err}`, {
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
  // hotfolderConfigFromEnv (see src/hotfolder.ts) — fixed here too even
  // though PORT/CONFIG_PATH are normally always set, since NaN/empty here
  // is just as dangerous if .env is ever incomplete.
  const port = parseInt(process.env.PORT || "8420", 10);
  const libraryRoot = process.env.LIBRARY_ROOT;
  const configPath = process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH;

  if (!libraryRoot) {
    throw new Error("LIBRARY_ROOT environment variable is required (Plex library root path)");
  }

  const plex = plexConfigFromEnv(libraryRoot);
  const discord = discordConfigFromEnv();
  const webui = webUiConfigFromEnv();

  return { port, libraryRoot, configPath, plex, discord, webui };
}
