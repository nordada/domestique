import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { matchShow } from "./matcher.js";
import { buildDestination } from "./namer.js";
import { copyIntoLibrary, resolveDynamicEpisode, resolveSourceItems } from "./fileops.js";

export interface ServerOptions {
  port: number;
  libraryRoot: string;
  configPath: string;
}

interface TorrentDonePayload {
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

async function handleTorrentDone(payload: TorrentDonePayload, opts: ServerOptions) {
  const results: Array<{
    sourceFile: string;
    status: string;
    destPath?: string;
    warning?: string | null;
  }> = [];

  const config = loadConfig(opts.configPath);
  let configDirty = false;

  const items = await resolveSourceItems(payload.dir, payload.name);
  console.log(`[torrent-done] "${payload.name}" -> ${items.length} file(s) to process`);

  for (const item of items) {
    const match = matchShow(item.parsed, config);
    if (match.autoCreated) {
      configDirty = true;
      console.warn(
        `[auto-create] No config match for "${item.parsed.raw}" -> created show "${match.show.id}" (folder "${match.show.folderName}"). Review config/shows.json.`
      );
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
    }

    const outcome = await copyIntoLibrary(
      item.sourceFile,
      opts.libraryRoot,
      plan.destDir,
      plan.destFilename
    );

    console.log(
      `[${outcome.status}] ${item.sourceFile} -> ${plan.destDir}/${plan.destFilename}`
    );

    results.push({
      sourceFile: item.sourceFile,
      status: outcome.status,
      destPath: outcome.destPath,
      warning: plan.warning,
    });
  }

  if (configDirty) {
    saveConfig(config, opts.configPath);
  }

  return results;
}

export function createApp(opts: ServerOptions) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

export function optionsFromEnv(): ServerOptions {
  const port = parseInt(process.env.PORT ?? "8420", 10);
  const libraryRoot = process.env.LIBRARY_ROOT;
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  if (!libraryRoot) {
    throw new Error("LIBRARY_ROOT environment variable is required (Plex library root path)");
  }

  return { port, libraryRoot, configPath };
}
