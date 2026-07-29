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

import { join } from "node:path";
import { stat, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadSettings, resolveReseedStagingRoot } from "./settings.js";
import { previewReseed, commitReseed } from "./reseed.js";
import { listSeedingTorrents } from "./seeding.js";
import { commitDedupe } from "./dedupe.js";
import { getTorrentLocation, removeTorrentAndData } from "./transmission.js";
import { isPathWithin } from "./fileops.js";
import { recordActivity } from "./activity.js";
import { readBody, readBodyBuffer, BodyTooLargeError, TORRENT_BODY_LIMIT_BYTES } from "./body.js";
import type { ServerOptions } from "./server.js";
import type { ProcessTorrentDone } from "./upload.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Handles /api/reseed/preview (a pure, non-destructive library query - see
 * previewReseed), /api/reseed/commit (stages matches and hands the torrent
 * to Transmission - see commitReseed), /api/reseed/seeding (a read-only
 * snapshot of every torrent Transmission is currently seeding or has
 * paused, matched against the library - see listSeedingTorrents in
 * seeding.ts), and /api/reseed/add-to-library (runs a seeding torrent
 * Transmission already has through the normal ingestion pipeline - see
 * below), /api/reseed/dedupe (converts a full-duplicate seeding torrent into
 * a hardlink-backed one - see dedupe.ts) and /api/reseed/delete-original
 * (the explicit follow-up that removes the now-orphaned original download-
 * folder copy), all backing the Reseed tab. Same "return true if handled"
 * contract as upload.ts/coverArt.ts, so webui.ts's dispatch chain stays
 * flat. Sits outside handleWebUiRequest's own try/catch (same as those two
 * sibling modules), so body-size and processing errors are handled here
 * directly rather than bubbling up.
 */
export async function handleReseedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  processTorrentDone: ProcessTorrentDone
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://internal");

  if (req.method === "GET" && url.pathname === "/api/reseed/seeding") {
    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    if (!settings.transmission) {
      sendJson(res, 400, {
        ok: false,
        error: "Transmission isn't configured - set its RPC URL in Settings before viewing seeding status.",
      });
      return true;
    }
    const stagingRoot = resolveReseedStagingRoot(settings, opts.libraryRoot);
    try {
      const torrents = await listSeedingTorrents(settings.transmission, opts.libraryRoot, stagingRoot);
      sendJson(res, 200, { ok: true, torrents });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `Failed to list seeding torrents: ${err}` });
    }
    return true;
  }

  /**
   * Takes a torrent Transmission is already seeding (found via the
   * Currently seeding list, typically one whose library file is missing/
   * unmatched) and runs it through the exact same parse/match/copy
   * pipeline the webhook and hot-folder use - same auto-create-a-show
   * behavior, same duplicate/quality handling, nothing new. `dir`/`name`
   * are re-fetched fresh from Transmission server-side (never trusting a
   * client-supplied path), then confined to the downloads share with the
   * same isPathWithin check the webhook itself uses - this also naturally
   * rejects a torrent whose data lives under the reseed staging directory
   * (that lives inside LIBRARY_ROOT, a different tree from the downloads
   * share entirely), so this can't be used to re-copy an already-staged
   * reseed back onto itself. Optional body field `force: true` (the
   * "Force file as new version" action) bypasses copyIntoLibrary's
   * "destination already exists" skip - for the case where an existing
   * file was already tagged with the same broadcaster, so the normal
   * heuristics conclude "already have this release" even though a human
   * has confirmed it's actually different.
   */
  if (req.method === "POST" && url.pathname === "/api/reseed/add-to-library") {
    let payload: { id?: unknown; force?: unknown };
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
    if (typeof payload.id !== "number") {
      sendJson(res, 400, { ok: false, error: "body must include a numeric id" });
      return true;
    }
    const force = payload.force === true;

    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    if (!settings.transmission) {
      sendJson(res, 400, {
        ok: false,
        error: "Transmission isn't configured - set its RPC URL in Settings before adding to the library.",
      });
      return true;
    }

    try {
      const location = await getTorrentLocation(settings.transmission, payload.id);
      if (!location) {
        sendJson(res, 404, { ok: false, error: `Transmission doesn't report a torrent with id ${payload.id}` });
        return true;
      }
      if (!isPathWithin(join(location.downloadDir, location.name), opts.downloadsPath)) {
        sendJson(res, 400, {
          ok: false,
          error: `"${location.name}" resolves outside the downloads share - refusing to process it`,
        });
        return true;
      }
      const results = await processTorrentDone({ dir: location.downloadDir, name: location.name }, opts, force);
      sendJson(res, 200, { ok: true, results });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `Failed to add to library: ${err}` });
    }
    return true;
  }

  /**
   * Removes a torrent from Transmission and deletes its downloaded data
   * (see transmission.ts's removeTorrentAndData) - the Currently seeding
   * list's "Remove & delete files" action, for a torrent that's stuck, a
   * duplicate, or just no longer wanted. Deliberately Transmission-only:
   * never touches anything already filed in the Plex library, matching
   * this app's standing rule that nothing in the library is ever
   * auto-deleted. The client gates this behind its own confirm() dialog
   * before ever sending the request, since it's irreversible.
   */
  if (req.method === "POST" && url.pathname === "/api/reseed/remove") {
    let payload: { id?: unknown };
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
    if (typeof payload.id !== "number") {
      sendJson(res, 400, { ok: false, error: "body must include a numeric id" });
      return true;
    }

    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    if (!settings.transmission) {
      sendJson(res, 400, {
        ok: false,
        error: "Transmission isn't configured - set its RPC URL in Settings before removing torrents.",
      });
      return true;
    }

    try {
      const location = await getTorrentLocation(settings.transmission, payload.id);
      if (!location) {
        sendJson(res, 404, { ok: false, error: `Transmission doesn't report a torrent with id ${payload.id}` });
        return true;
      }
      await removeTorrentAndData(settings.transmission, payload.id);
      recordActivity(
        {
          timestamp: new Date().toISOString(),
          torrentName: location.name,
          lines: [`🗑️ removed "${location.name}" from Transmission and deleted its downloaded data.`],
          reviewWorthy: false,
        },
        opts.activityPath
      );
      sendJson(res, 200, { ok: true, name: location.name });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `Failed to remove torrent: ${err}` });
    }
    return true;
  }

  /**
   * Converts a seeding torrent's data from a full duplicate (copied the
   * normal way into both the downloads share and the library, see
   * fileops.ts's copyIntoLibrary) into a hardlink-backed dedupe - see
   * dedupe.ts's commitDedupe for the actual mechanics and safety net
   * (automatic revert on anything but a clean verify). Deliberately does
   * NOT delete the original download-folder copy itself - that's a
   * separate, explicit follow-up action (/api/reseed/delete-original
   * below), matching this app's standing "nothing is ever auto-deleted"
   * rule everywhere else.
   */
  if (req.method === "POST" && url.pathname === "/api/reseed/dedupe") {
    let payload: { id?: unknown };
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
    if (typeof payload.id !== "number") {
      sendJson(res, 400, { ok: false, error: "body must include a numeric id" });
      return true;
    }

    const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
    if (!settings.transmission) {
      sendJson(res, 400, {
        ok: false,
        error: "Transmission isn't configured - set its RPC URL in Settings before deduping.",
      });
      return true;
    }
    const stagingRoot = resolveReseedStagingRoot(settings, opts.libraryRoot);

    try {
      const result = await commitDedupe(payload.id, opts.libraryRoot, stagingRoot, settings.transmission);
      const lines: string[] = [];
      if (!result.staged && !result.reverted) {
        lines.push(
          `⚠️ "${result.plan.torrentName}" isn't a full, unambiguous match against the library - refusing to dedupe.`
        );
      } else if (result.staged) {
        lines.push(`🔗 deduped "${result.plan.torrentName}" - Transmission verified 100% against the library copy.`);
      } else {
        lines.push(
          `⚠️ dedupe of "${result.plan.torrentName}" failed verify (${
            result.verify?.errorString || "incomplete"
          }) - reverted back to its original location, untouched.`
        );
      }
      recordActivity(
        {
          timestamp: new Date().toISOString(),
          torrentName: result.plan.torrentName,
          lines,
          reviewWorthy: !result.staged,
        },
        opts.activityPath
      );
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `Failed to dedupe: ${err}` });
    }
    return true;
  }

  /**
   * Deletes a single file - only ever called by the UI right after a
   * successful dedupe, targeting the original download-folder copy that
   * dedupe's own response reported (see the "Delete original copy" button
   * in public/index.html). Re-validated with the exact same isPathWithin
   * confinement to the downloads share the webhook itself uses for a
   * client-supplied dir/name - never blind-trusted, even though the client
   * is only ever passing back a path this same API just handed it.
   * Deliberately not routed through removeTorrentAndData: after a dedupe,
   * Transmission's own record no longer points at this path at all (it's
   * been relocated to the staging directory), so there's no torrent-remove
   * call that would reach this specific orphaned file.
   */
  if (req.method === "POST" && url.pathname === "/api/reseed/delete-original") {
    let payload: { dir?: unknown; name?: unknown };
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
    if (typeof payload.dir !== "string" || typeof payload.name !== "string") {
      sendJson(res, 400, { ok: false, error: "body must include dir and name" });
      return true;
    }

    const targetPath = join(payload.dir, payload.name);
    if (!isPathWithin(targetPath, opts.downloadsPath)) {
      sendJson(res, 400, { ok: false, error: "dir/name must resolve inside the downloads share" });
      return true;
    }

    try {
      const info = await stat(targetPath);
      await rm(targetPath, { recursive: true });
      recordActivity(
        {
          timestamp: new Date().toISOString(),
          torrentName: payload.name,
          lines: [`🗑️ deleted the now-deduped original download-folder copy of "${payload.name}" (${info.size} bytes).`],
          reviewWorthy: false,
        },
        opts.activityPath
      );
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `Failed to delete "${payload.name}": ${err}` });
    }
    return true;
  }

  const knownPaths = new Set(["/api/reseed/preview", "/api/reseed/commit"]);
  if (req.method !== "POST" || !knownPaths.has(url.pathname)) return false;

  let torrentBuf: Buffer;
  try {
    torrentBuf = await readBodyBuffer(req, TORRENT_BODY_LIMIT_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return true;
    }
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
  const stagingRoot = resolveReseedStagingRoot(settings, opts.libraryRoot);

  if (url.pathname === "/api/reseed/preview") {
    try {
      const plan = await previewReseed(torrentBuf, opts.libraryRoot, stagingRoot);
      sendJson(res, 200, { ok: true, plan });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  // /api/reseed/commit
  if (!settings.transmission) {
    const message = "Transmission isn't configured - set its RPC URL in Settings before reseeding.";
    recordActivity(
      { timestamp: new Date().toISOString(), torrentName: "reseed", lines: [`❌ ${message}`], reviewWorthy: true },
      opts.activityPath
    );
    sendJson(res, 400, { ok: false, error: message });
    return true;
  }

  try {
    const result = await commitReseed(torrentBuf, opts.libraryRoot, stagingRoot, settings.transmission);
    const verify = result.transmission?.verify;
    const lines: string[] = [];

    if (!result.staged) {
      lines.push(`❌ no matches found in the library for "${result.torrentName}" - nothing staged.`);
    } else {
      lines.push(
        `✅ staged ${result.stagedFiles.length}/${result.files.length} file(s) for "${result.torrentName}".`
      );
      if (result.ambiguousCount > 0) {
        lines.push(
          `⚠️ ${result.ambiguousCount} file(s) had multiple same-size candidates in the library - not guessed, left unstaged.`
        );
      }
      if (result.unmatchedCount > 0) {
        lines.push(`⚠️ ${result.unmatchedCount} file(s) had no library match at all.`);
      }
      if (result.transmission?.added.duplicate) {
        lines.push(`⚠️ "${result.transmission.added.name}" was already in Transmission (duplicate).`);
      }
      if (verify) {
        if (verify.error) {
          lines.push(`⚠️ Transmission reports an error after verifying: ${verify.errorString}`);
        } else if (verify.percentDone === 1) {
          lines.push(
            result.transmission?.started
              ? "Transmission verified 100% of this torrent's data and started seeding."
              : "⚠️ Transmission verified 100% of this torrent's data, but couldn't be started automatically - start it manually in Transmission."
          );
        } else {
          lines.push(
            `⚠️ Transmission verified only ${Math.round(verify.percentDone * 100)}% of this torrent's data - left paused for review.`
          );
        }
      } else {
        lines.push(
          "⚠️ Added to Transmission, but could not confirm its verify result after polling - check Transmission directly."
        );
      }
    }

    const reviewWorthy =
      !result.staged ||
      result.ambiguousCount > 0 ||
      result.unmatchedCount > 0 ||
      Boolean(result.transmission?.added.duplicate) ||
      !verify ||
      Boolean(verify.error) ||
      verify.percentDone < 1 ||
      !result.transmission?.started;

    recordActivity(
      { timestamp: new Date().toISOString(), torrentName: result.torrentName, lines, reviewWorthy },
      opts.activityPath
    );
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    const message = `Failed to reseed: ${err}`;
    recordActivity(
      { timestamp: new Date().toISOString(), torrentName: "reseed", lines: [`❌ ${message}`], reviewWorthy: true },
      opts.activityPath
    );
    sendJson(res, 500, { ok: false, error: message });
  }
  return true;
}
