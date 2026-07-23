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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { loadSettings, resolveCoverArtSettings, DEFAULT_SETTINGS_PATH } from "./settings.js";
import { matchShow } from "./matcher.js";
import { buildDestination } from "./namer.js";
import { copyIntoLibrary, resolveDynamicEpisode, resolveSourceItems, isPathWithin } from "./fileops.js";
import { refreshPlexFolder } from "./plex.js";
import { generateCoverArt, refreshPlexForShows } from "./coverArt.js";
import { sendDiscordNotification } from "./discord.js";
import { recordActivity, DEFAULT_ACTIVITY_PATH } from "./activity.js";
import { webUiConfigFromEnv, handleWebUiRequest, constantTimeEqual, type WebUiConfig } from "./webui.js";
import { readBody, BodyTooLargeError } from "./body.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAVICON_PATH = join(__dirname, "..", "public", "favicon.svg");
const ICONS_DIR = join(__dirname, "..", "public", "icons");
// Allow-listed rather than an open static-file route off req.url, so a
// crafted path can't escape ICONS_DIR - same "unauthenticated but not
// attacker-controlled" trust level as the favicon route below.
const ICON_FILES = new Set(["plex.svg", "hotfolder.svg", "transmission.svg", "indexer.svg"]);

export interface ServerOptions {
  port: number;
  libraryRoot: string;
  configPath: string;
  settingsPath: string;
  activityPath: string;
  /** In-container path the downloads/seeding share is mounted at (see docker-compose.yml) - used only to check reachability for the header status gauge, not read from otherwise. */
  downloadsPath: string;
  webui: WebUiConfig | null;
}

export interface TorrentDonePayload {
  dir: string;
  name: string;
  id?: string;
  hash?: string;
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
  const touchedShowIds = new Set<string>();
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
      touchedShowIds.add(match.show.id);
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

  if (settings.coverArt.enabled) {
    const freshlyGeneratedShows: typeof config.shows = [];
    for (const showId of touchedShowIds) {
      const show = config.shows.find((s) => s.id === showId);
      if (!show) continue;
      const showRootFolder = join(opts.libraryRoot, show.folderName);
      const posterPath = join(showRootFolder, "poster.jpg");
      // A static poster only needs generating once per show, the first time
      // any episode is archived - not re-checked on every event, or a
      // multi-stage race would re-render on every single stage. Settings
      // Tab's "regenerate all posters" (see coverArt.ts) forces a redo after
      // a logo or color change.
      if (existsSync(posterPath)) continue;
      try {
        const effective = resolveCoverArtSettings(settings.coverArt, show.coverArt);
        const result = await generateCoverArt(show, effective, opts.libraryRoot);
        if (result.status === "written") {
          summaryLines.push(`🖼️ generated cover art for "${show.id}"`);
          freshlyGeneratedShows.push(show);
        }
      } catch (err) {
        console.warn(`[cover-art] failed to generate poster for "${show.id}": ${err}`);
        reviewWorthy = true;
        summaryLines.push(`⚠️ cover art generation failed for "${show.id}": ${err}`);
      }
    }
    // Batched into one ratingKey lookup for every show touched this run,
    // rather than one lookup per show - a webhook rarely touches more than
    // one show, but this keeps the same shape as regenerate-all's batching
    // and avoids re-adding the earlier per-show version's slowdown if that
    // ever changes.
    if (settings.plex && freshlyGeneratedShows.length > 0) {
      const failures = await refreshPlexForShows(settings.plex, freshlyGeneratedShows, opts.libraryRoot);
      for (const { show, error } of failures) {
        reviewWorthy = true;
        summaryLines.push(`⚠️ Plex refresh failed for "${show.id}" after cover art generation: ${error}`);
      }
    }
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

  recordActivity(
    {
      timestamp: new Date().toISOString(),
      torrentName: payload.name,
      lines: summaryLines,
      reviewWorthy,
    },
    opts.activityPath
  );

  return results;
}

export function createApp(opts: ServerOptions) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Defense-in-depth headers on every response, set up front so each
    // route's own writeHead merges with (rather than needs to repeat) them.
    // frame-ancestors/X-Frame-Options: a hostile site must not be able to
    // iframe /ui (the browser would helpfully attach cached Basic Auth
    // credentials to the framed requests). nosniff: never let a browser
    // second-guess a Content-Type. no-store on /api/*: those responses
    // carry settings/activity data that has no business in any cache.
    // HSTS is deliberately absent: TLS terminates at Cloudflare, which
    // manages that header itself.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }

    // The bare root has no route of its own; redirect straight to the web
    // UI so a bookmark or a reverse proxy's default hostname (Cloudflare
    // Tunnel, etc) lands somewhere useful instead of a 404. Unconditional:
    // if the web UI itself is disabled, /ui just shows its own 503, same
    // as navigating there directly.
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(302, { Location: "/ui" });
      res.end();
      return;
    }

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
      } catch (err) {
        // Logged because "not found" here is usually a deploy problem, not
        // a bad request: a real incident had two icon files land mode 600
        // via rsync, unreadable once the container dropped to a non-root
        // PUID user, and the silent 404 made it look like a UI bug.
        console.warn(`[static] failed to read favicon: ${err}`);
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
      } catch (err) {
        // See the favicon route above for why this logs.
        console.warn(`[static] failed to read ${req.url}: ${err}`);
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
        const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
        // This route has no other auth: it's meant to be called only by
        // Transmission's own hook script, trusted implicitly on a LAN.
        // webhookSecret is the retrofit for anyone exposing the app past
        // their LAN; null (the default) keeps the original open behavior so
        // existing deployments aren't broken. Checked before touching the
        // body at all, so an unauthorized caller can't even reach the dir/
        // name handling below.
        if (settings.webhookSecret) {
          const provided = req.headers["x-webhook-secret"];
          if (typeof provided !== "string" || !constantTimeEqual(provided, settings.webhookSecret)) {
            // Never echo the provided value: a near-miss secret in the log
            // is still a secret. Present-but-wrong vs missing is enough to
            // tell "stale hook script that sends no header" apart from a
            // mismatched torrent-done.env.
            console.warn(
              `[webhook] rejected torrent-done from ${req.socket.remoteAddress ?? "unknown address"}: ${typeof provided === "string" ? "incorrect" : "missing"} X-Webhook-Secret header`
            );
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing or incorrect X-Webhook-Secret header" }));
            return;
          }
        }
        const body = await readBody(req);
        const payload = JSON.parse(body) as TorrentDonePayload;
        if (!payload.dir || !payload.name) {
          console.warn(
            `[webhook] rejected torrent-done from ${req.socket.remoteAddress ?? "unknown address"}: payload missing dir and/or name`
          );
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload must include dir and name" }));
          return;
        }
        // A legitimate call's dir/name always resolves under the downloads
        // share (that's what TR_TORRENT_DIR is). Confining it here, at the
        // one HTTP-facing entry point that accepts an attacker-suppliable
        // dir/name, closes off reading (and copying into the library) any
        // other path the container can see: config/settings.json's real
        // secrets, LIBRARY_ROOT itself, etc, even if webhookSecret above is
        // unset or leaks. Deliberately checked on the SAME joined path
        // resolveSourceItems itself will stat, not just payload.dir alone,
        // since payload.name could otherwise carry its own "../" escape.
        if (!isPathWithin(join(payload.dir, payload.name), opts.downloadsPath)) {
          // Logging the offending dir/name here is safe (it's the caller's
          // own input, not a secret) and is exactly what's needed to spot a
          // mount-path mismatch between Transmission's container and this
          // one, which would silently reject every legitimate webhook.
          console.warn(
            `[webhook] rejected torrent-done from ${req.socket.remoteAddress ?? "unknown address"}: dir/name resolves outside the downloads share (dir="${payload.dir}", name="${payload.name}", downloads share is "${opts.downloadsPath}")`
          );
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "dir/name must resolve inside the downloads share" }));
          return;
        }
        if (settings.paused) {
          console.log(`[webhook] paused - skipping "${payload.name}"`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, paused: true, results: [] }));
          return;
        }
        const results = await handleTorrentDone(payload, opts);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
        console.error("[webhook] error handling torrent-done:", err);
        const discord = loadSettings(opts.settingsPath, opts.libraryRoot).discord;
        if (discord) {
          sendDiscordNotification(discord, `❌ webhook error handling torrent-done: ${err}`, {
            mention: true,
          }).catch((notifyErr) => console.warn(`[discord] failed to send notification: ${notifyErr}`));
        }
        // The full error already went to the console (and Discord, a private
        // owner-only channel) above; the HTTP response stays generic so a
        // caller can't fish for internal filesystem paths in error strings.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal error" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // Node's default requestTimeout (5 minutes) would kill a large web-UI
  // upload (src/upload.ts) partway through on anything less than a very
  // fast connection, so it stays disabled: any finite value generous enough
  // for a multi-gigabyte upload over a slow link wouldn't meaningfully
  // bound anything anyway. This does accept that a client can hold a body
  // open indefinitely; for an internet-facing deployment the mitigation is
  // upstream (Cloudflare Access or an equivalent auth proxy), not here.
  // headersTimeout is set explicitly because its default is derived from
  // requestTimeout, and disabling that must not also disable the header
  // deadline: headers are tiny, so a client that can't finish them in 60
  // seconds is a slowloris, not a slow uplink.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

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
  const activityPath = process.env.ACTIVITY_PATH || DEFAULT_ACTIVITY_PATH;
  // Fixed by convention (see docker-compose.yml's DOWNLOADS_DIR mount and
  // the README) rather than DOWNLOADS_DIR itself, which is only ever a host
  // path - DOWNLOADS_PATH lets this be overridden if that mount target
  // ever changes, mirroring CONFIG_PATH/SETTINGS_PATH above.
  const downloadsPath = process.env.DOWNLOADS_PATH || "/downloads";

  if (!libraryRoot) {
    throw new Error("LIBRARY_ROOT environment variable is required (Plex library root path)");
  }

  const webui = webUiConfigFromEnv();

  return { port, libraryRoot, configPath, settingsPath, activityPath, downloadsPath, webui };
}
