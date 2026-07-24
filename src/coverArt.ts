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

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";
import { loadConfig, type ShowConfig, type ShowsConfigFile } from "./config.js";
import { loadSettings, resolveCoverArtSettings, type CoverArtSettings } from "./settings.js";
import { readBody, readBodyBuffer, BodyTooLargeError } from "./body.js";
import { sanitizeName } from "./upload.js";
import { searchCommonsLogos, fetchCommonsFile } from "./wikimediaCommons.js";
import {
  refreshPlexFolder,
  fetchShowRatingKeyIndex,
  lookupShowRatingKey,
  forceRefreshItem,
  type PlexConfig,
  type PlexShowRatingKeyIndex,
} from "./plex.js";
import type { ServerOptions } from "./server.js";

// A hidden folder under LIBRARY_ROOT, same "invisible to Plex, already
// RW-mounted, already sized for large media" reasoning upload.ts documents
// for .uploads-tmp - no new Docker volume or config/ bind mount needed.
const LOGO_SUBDIR = ".cover-art/logos";

// Logos are small compared to the video/torrent uploads elsewhere in this
// app, so a much tighter cap than TORRENT_BODY_LIMIT_BYTES is appropriate.
const LOGO_BODY_LIMIT_BYTES = 8_000_000;
const LOGO_MAX_DIMENSION = 1200;

// Plex's standard 2:3 poster/show-art aspect ratio.
const POSTER_WIDTH = 1000;
const POSTER_HEIGHT = 1500;

function logoPath(libraryRoot: string, showId: string): string {
  return join(libraryRoot, LOGO_SUBDIR, `${showId}.png`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Resolves the showId query param to a real config entry - this is the
 * actual authorization boundary for the logo routes, since it means a
 * caller can only ever read/write a filename that already corresponds to a
 * real, existing show id, not an arbitrary attacker-chosen name.
 */
function requireShow(url: URL, res: ServerResponse, config: ShowsConfigFile): ShowConfig | null {
  const raw = url.searchParams.get("showId");
  if (!raw) {
    sendJson(res, 400, { error: "showId query param is required" });
    return null;
  }
  let showId: string;
  try {
    showId = sanitizeName(raw);
  } catch (err) {
    sendJson(res, 400, { error: String(err) });
    return null;
  }
  const show = config.shows.find((s) => s.id === showId);
  if (!show) {
    sendJson(res, 400, { error: `unknown show id: ${showId}` });
    return null;
  }
  return show;
}

/**
 * Normalizes raw image bytes to PNG (alpha preserved) and writes them as a
 * show's logo, tmp-then-rename. Shared by both logo sources - a direct
 * browser upload and a Wikipedia/Commons pick - so there's exactly one
 * place that defines what "a valid logo" means, regardless of where the
 * bytes came from. Normalizing doubles as real image-content validation:
 * sharp throws on non-image/corrupt bytes rather than trusting a
 * Content-Type header or file extension. Also caps dimensions so a huge
 * source image can't balloon disk usage or slow every future poster
 * composite. Throws on invalid image data - callers decide how to report
 * that to their own caller.
 */
async function saveNormalizedLogo(raw: Buffer, opts: ServerOptions, show: ShowConfig): Promise<void> {
  const normalized = await sharp(raw)
    .resize({ width: LOGO_MAX_DIMENSION, height: LOGO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  const dir = join(opts.libraryRoot, LOGO_SUBDIR);
  await mkdir(dir, { recursive: true });
  const finalPath = logoPath(opts.libraryRoot, show.id);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, normalized);
  await rename(tmpPath, finalPath);
}

async function handleLogoUpload(req: IncomingMessage, res: ServerResponse, opts: ServerOptions, url: URL): Promise<void> {
  const config = loadConfig(opts.configPath);
  const show = requireShow(url, res, config);
  if (!show) return;

  let raw: Buffer;
  try {
    raw = await readBodyBuffer(req, LOGO_BODY_LIMIT_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    throw err;
  }

  try {
    await saveNormalizedLogo(raw, opts, show);
  } catch {
    sendJson(res, 400, { error: "not a valid image" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

async function handleLogoSearch(res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams.get("q")?.trim();
  if (!q) {
    sendJson(res, 400, { error: "q query param is required" });
    return;
  }
  try {
    const results = await searchCommonsLogos(q);
    sendJson(res, 200, { results });
  } catch (err) {
    sendJson(res, 502, { error: `Wikipedia search failed: ${err}` });
  }
}

async function handleLogoFromUrl(req: IncomingMessage, res: ServerResponse, opts: ServerOptions, url: URL): Promise<void> {
  const config = loadConfig(opts.configPath);
  const show = requireShow(url, res, config);
  if (!show) return;

  const body = await readBody(req);
  let payload: { url?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof payload.url !== "string" || !payload.url) {
    sendJson(res, 400, { error: "url is required" });
    return;
  }

  let raw: Buffer;
  try {
    raw = await fetchCommonsFile(payload.url);
  } catch (err) {
    sendJson(res, 502, { error: `failed to fetch image: ${err}` });
    return;
  }

  try {
    await saveNormalizedLogo(raw, opts, show);
  } catch {
    sendJson(res, 400, { error: "not a valid image" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

async function handleLogoGet(res: ServerResponse, opts: ServerOptions, url: URL): Promise<void> {
  const config = loadConfig(opts.configPath);
  const show = requireShow(url, res, config);
  if (!show) return;

  try {
    const buffer = await readFile(logoPath(opts.libraryRoot, show.id));
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(buffer);
  } catch {
    sendJson(res, 404, { error: "no logo set for this show" });
  }
}

async function handleLogoDelete(res: ServerResponse, opts: ServerOptions, url: URL): Promise<void> {
  const config = loadConfig(opts.configPath);
  const show = requireShow(url, res, config);
  if (!show) return;

  await rm(logoPath(opts.libraryRoot, show.id), { force: true });
  sendJson(res, 200, { ok: true });
}

async function refreshOnePlexShow(
  plex: PlexConfig,
  show: ShowConfig,
  libraryRoot: string,
  index: PlexShowRatingKeyIndex | null
): Promise<void> {
  const showRootFolder = join(libraryRoot, show.folderName);
  const ratingKey = index ? lookupShowRatingKey(index, plex, libraryRoot, showRootFolder) : null;
  if (ratingKey) {
    await forceRefreshItem(plex, ratingKey);
  } else {
    await refreshPlexFolder(plex, libraryRoot, showRootFolder);
  }
}

/**
 * Tells Plex to actually look at each show's freshly (re)generated poster.
 * A passive path-scoped scan (refreshPlexFolder) reliably detects new
 * episode files, but real-world testing found it does NOT reliably
 * re-examine local media assets for a show Plex already considers fully
 * matched - "Scan Library" left a new poster invisible in Plex's poster
 * picker, while Plex's own per-item "Refresh Metadata" picked it up
 * immediately. So this looks up each show's Plex ratingKey and forces a
 * per-item refresh, falling back to the passive folder refresh for any
 * show Plex hasn't indexed at all yet (e.g. brand-new).
 *
 * Fetches the ratingKey index ONCE for the whole batch, not once per show -
 * an earlier version looked a show up individually inside this same loop,
 * which meant regenerating a few dozen posters re-fetched Plex's entire
 * section listing a few dozen times in one request, slow enough in
 * practice to look hung.
 */
export async function refreshPlexForShows(
  plex: PlexConfig,
  shows: ShowConfig[],
  libraryRoot: string
): Promise<Array<{ show: ShowConfig; error: unknown }>> {
  let index: PlexShowRatingKeyIndex | null = null;
  try {
    index = await fetchShowRatingKeyIndex(plex);
  } catch (err) {
    console.warn(`[plex] ratingKey index fetch failed, falling back to passive folder refreshes: ${err}`);
  }

  const failures: Array<{ show: ShowConfig; error: unknown }> = [];
  for (const show of shows) {
    try {
      await refreshOnePlexShow(plex, show, libraryRoot, index);
    } catch (err) {
      console.warn(`[plex] refresh failed for "${show.id}": ${err}`);
      failures.push({ show, error: err });
    }
  }
  return failures;
}

/**
 * Guards against overlapping regenerate-all runs - a real incident this
 * closes: the web UI's "Regenerate all posters" button had no
 * disable-while-running guard, so impatient repeat clicks (or multiple
 * open tabs) could fire several full regenerate-all requests concurrently.
 * Each one independently looped every logo'd show and force-refreshed it
 * in Plex, and the pile-up was enough to make Plex itself unresponsive to
 * everything, including the trivial /identity liveness check the header
 * status gauge uses. A second request while one is already in progress is
 * now rejected outright (409) rather than starting another overlapping
 * run - this is server-side defense in depth, independent of the client-
 * side button-disable fix in public/index.html.
 */
let regenerateInProgress = false;

/**
 * Regenerating writes new poster.jpg files to disk, but Plex won't pick
 * them up on its own until its next scheduled library scan - which can be
 * hours away, the same class of "silently stale until someone notices"
 * problem a missing partial-scan refresh caused before (see server.ts's
 * handleTorrentDone). So every show that actually got a new poster this
 * run gets an explicit refresh via refreshPlexForShows above, batched into
 * one ratingKey lookup for the whole run.
 */
async function handleRegenerateAll(res: ServerResponse, opts: ServerOptions): Promise<void> {
  if (regenerateInProgress) {
    sendJson(res, 409, { error: "a regenerate-all run is already in progress - wait for it to finish" });
    return;
  }
  regenerateInProgress = true;
  try {
    const config = loadConfig(opts.configPath);
    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    const results = await regenerateAllCoverArt(config, settings.coverArt, opts.libraryRoot);

    if (settings.plex) {
      const writtenShows = results
        .filter((r) => r.result.status === "written")
        .map((r) => config.shows.find((s) => s.id === r.id))
        .filter((s): s is ShowConfig => Boolean(s));
      if (writtenShows.length > 0) {
        await refreshPlexForShows(settings.plex, writtenShows, opts.libraryRoot);
      }
    }

    sendJson(res, 200, { ok: true, results });
  } finally {
    regenerateInProgress = false;
  }
}

/**
 * Handles any /api/cover-art/* request. Returns false for anything that
 * isn't one of these routes, matching handleUploadRequest's "return true if
 * handled" contract. Errors are caught here (not left to propagate) since
 * this is dispatched before webui.ts's own outer try/catch.
 */
export async function handleCoverArtRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://internal");
  const knownPaths = new Set([
    "/api/cover-art/logo",
    "/api/cover-art/regenerate",
    "/api/cover-art/logo-search",
    "/api/cover-art/logo/from-url",
  ]);
  if (!knownPaths.has(url.pathname)) {
    return false;
  }

  try {
    if (url.pathname === "/api/cover-art/logo") {
      if (req.method === "POST") {
        await handleLogoUpload(req, res, opts, url);
        return true;
      }
      if (req.method === "GET") {
        await handleLogoGet(res, opts, url);
        return true;
      }
      if (req.method === "DELETE") {
        await handleLogoDelete(res, opts, url);
        return true;
      }
      return false;
    }

    if (url.pathname === "/api/cover-art/regenerate" && req.method === "POST") {
      await handleRegenerateAll(res, opts);
      return true;
    }

    if (url.pathname === "/api/cover-art/logo-search" && req.method === "GET") {
      await handleLogoSearch(res, url);
      return true;
    }

    if (url.pathname === "/api/cover-art/logo/from-url" && req.method === "POST") {
      await handleLogoFromUrl(req, res, opts, url);
      return true;
    }

    return false;
  } catch (err) {
    console.error(`[cover-art] unexpected error handling ${req.method} ${url.pathname}:`, err);
    sendJson(res, 500, { error: "internal error" });
    return true;
  }
}

export interface CoverArtResult {
  status: "written" | "skipped" | "error";
  posterPath?: string;
  error?: string;
}

function backgroundSvg(width: number, height: number, colorFrom: string, colorTo: string | null): string {
  if (!colorTo) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${colorFrom}"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colorFrom}"/>
      <stop offset="100%" stop-color="${colorTo}"/>
    </linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
  </svg>`;
}

/**
 * Generates a static Plex poster for a show from its uploaded logo, written
 * to the show-root folder (one level above any "Season NNNN" folder) so
 * it's reused across every season/year rather than regenerated per-year -
 * the logo represents the race brand, not one edition of it. A show with no
 * uploaded logo is a deliberate no-op (skipped, not a generic text
 * placeholder) - cover art is purely opt-in per show via the Events tab.
 */
export async function generateCoverArt(
  show: ShowConfig,
  coverArt: CoverArtSettings,
  libraryRoot: string,
  opts: { force?: boolean } = {}
): Promise<CoverArtResult> {
  const showRootFolder = join(libraryRoot, show.folderName);
  const posterPath = join(showRootFolder, "poster.jpg");
  const logo = logoPath(libraryRoot, show.id);

  if (!existsSync(logo)) {
    return { status: "skipped", posterPath };
  }
  if (!opts.force && existsSync(posterPath)) {
    return { status: "skipped", posterPath };
  }

  try {
    const bgSvg = backgroundSvg(POSTER_WIDTH, POSTER_HEIGHT, coverArt.backgroundColor, coverArt.backgroundColor2);
    const overlayInput = await sharp(logo)
      .resize({
        width: Math.round(Math.min(POSTER_WIDTH, POSTER_HEIGHT) * coverArt.logoScale),
        height: Math.round(Math.min(POSTER_WIDTH, POSTER_HEIGHT) * coverArt.logoScale),
        fit: "inside",
      })
      .toBuffer();

    const jpegBuffer = await sharp(Buffer.from(bgSvg))
      .composite([{ input: overlayInput, gravity: "center" }])
      .jpeg({ quality: 90 })
      .toBuffer();

    await mkdir(showRootFolder, { recursive: true });
    const tmpPath = `${posterPath}.tmp`;
    await writeFile(tmpPath, jpegBuffer);
    await rename(tmpPath, posterPath);

    return { status: "written", posterPath };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}

/** Force-regenerates every show's poster - the manual re-trigger after a logo or Settings-tab/per-event color change. */
export async function regenerateAllCoverArt(
  config: ShowsConfigFile,
  coverArt: CoverArtSettings,
  libraryRoot: string
): Promise<Array<{ id: string; result: CoverArtResult }>> {
  const results: Array<{ id: string; result: CoverArtResult }> = [];
  for (const show of config.shows) {
    const effective = resolveCoverArtSettings(coverArt, show.coverArt);
    results.push({ id: show.id, result: await generateCoverArt(show, effective, libraryRoot, { force: true }) });
  }
  return results;
}
