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

export interface TransmissionConfig {
  url: string;
  username?: string;
  password?: string;
}

/** Transmission serves its web UI at /transmission/web/ on the same host/port as RPC, regardless of the RPC URL's own path (which can vary, e.g. a reverse-proxy prefix) - lets the header gauge link straight to it from just the configured RPC URL. */
export function transmissionWebUrl(config: TransmissionConfig): string {
  return `${new URL(config.url).origin}/transmission/web/`;
}

function authHeader(config: TransmissionConfig): Record<string, string> {
  if (!config.username) return {};
  const token = Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

/**
 * Transmission's RPC endpoint requires a CSRF session id: a request sent
 * without one always comes back 409 with an X-Transmission-Session-Id header
 * to retry with, even when credentials are otherwise valid. Shared by every
 * RPC call this module makes - throws on any failure (bad auth, non-2xx,
 * a non-"success" result, or a network/timeout error) so callers can decide
 * for themselves how to fall back.
 */
async function rpcCall(
  config: TransmissionConfig,
  method: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<{ result?: string; arguments?: Record<string, unknown> }> {
  const headers = { "Content-Type": "application/json", ...authHeader(config) };
  const body = JSON.stringify(args ? { method, arguments: args } : { method });
  const first = await fetch(config.url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  let res = first;
  if (first.status === 409) {
    const sessionId = first.headers.get("x-transmission-session-id");
    if (!sessionId) {
      throw new Error(`${config.url} returned 409 without an X-Transmission-Session-Id header`);
    }
    res = await fetch(config.url, {
      method: "POST",
      headers: { ...headers, "X-Transmission-Session-Id": sessionId },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  if (!res.ok) {
    // The two most common causes here: rpc-whitelist/rpc-host-whitelist in
    // Transmission's own settings.json rejecting this container's IP/Host
    // header (403), or the RPC URL missing its /transmission/rpc suffix
    // (404) - both look identical from here, so surface the status to
    // point whoever's debugging at Transmission's own config/logs.
    throw new Error(`${config.url} responded ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { result?: string; arguments?: Record<string, unknown> };
  if (data.result !== "success") {
    throw new Error(`${config.url} responded with result "${data.result}"`);
  }
  return data;
}

/** Cheap reachability probe - a successful "session-get" round-trip is treated as "live". */
export async function checkTransmissionLive(config: TransmissionConfig, timeoutMs = 3000): Promise<boolean> {
  try {
    await rpcCall(config, "session-get", undefined, timeoutMs);
    return true;
  } catch (err) {
    console.warn(`[transmission] failed to reach ${config.url}: ${err}`);
    return false;
  }
}

export interface TransmissionTorrentSummary {
  total: number;
  /** At least one torrent has a tracker or local error (RPC `error` field != 0). */
  hasError: boolean;
  /** At least one torrent is actively downloading or queued to (RPC `status` 3 or 4) - as opposed to idle/verifying/seeding. */
  downloading: boolean;
}

// From Transmission's RPC spec (tr_torrent_activity): 3 = queued to
// download, 4 = downloading.
const STATUS_DOWNLOAD_WAIT = 3;
const STATUS_DOWNLOADING = 4;

/**
 * Fetches a lightweight status/error summary across all torrents, used to
 * color the header gauge's glow ring by what Transmission is actually doing
 * rather than just whether it's reachable. Returns null if the call fails
 * for any reason (RPC disabled, permissions, network) - this is
 * presentation-only, so callers should just fall back to treating
 * Transmission as unreachable rather than erroring.
 */
export async function getTransmissionTorrentSummary(
  config: TransmissionConfig,
  timeoutMs = 3000
): Promise<TransmissionTorrentSummary | null> {
  try {
    const data = await rpcCall(config, "torrent-get", { fields: ["status", "error"] }, timeoutMs);
    const torrents = (data.arguments?.torrents ?? []) as Array<{ status: number; error: number }>;
    return {
      total: torrents.length,
      hasError: torrents.some((t) => t.error !== 0),
      downloading: torrents.some((t) => t.status === STATUS_DOWNLOAD_WAIT || t.status === STATUS_DOWNLOADING),
    };
  } catch (err) {
    console.warn(`[transmission] failed to fetch torrent summary from ${config.url}: ${err}`);
    return null;
  }
}

export interface AddedTorrent {
  id: number;
  name: string;
  hashString: string;
  /** True if Transmission already had this torrent (RPC's "torrent-duplicate" rather than "torrent-added") - not an error, just not a new download. */
  duplicate: boolean;
}

export interface AddTorrentOptions {
  /** Passed through as RPC `download-dir` - where Transmission should look for (and write) this torrent's data. Omitted entirely from the RPC args when unset, so existing callers (the plain "Add torrent" feature) are unaffected. */
  downloadDir?: string;
  /** Passed through as RPC `paused` - true for the reseed-from-library flow (src/reseed.ts), which wants Transmission's own verify pass to run against the staged files before anything starts announcing/downloading. */
  paused?: boolean;
}

/**
 * Hands a .torrent file's raw bytes to Transmission via RPC `torrent-add`
 * (its `metainfo` argument, base64-encoded file contents - as opposed to
 * `filename`, which is for a URL/magnet/path Transmission itself fetches).
 * Throws on any failure, same as the other RPC calls here - callers decide
 * how to surface that.
 */
export async function addTorrentToTransmission(
  config: TransmissionConfig,
  metainfoBase64: string,
  opts: AddTorrentOptions = {},
  timeoutMs = 10000
): Promise<AddedTorrent> {
  const args: Record<string, unknown> = { metainfo: metainfoBase64 };
  if (opts.downloadDir !== undefined) args["download-dir"] = opts.downloadDir;
  if (opts.paused !== undefined) args.paused = opts.paused;
  const data = await rpcCall(config, "torrent-add", args, timeoutMs);
  const added = data.arguments?.["torrent-added"] as { id: number; name: string; hashString: string } | undefined;
  const duplicate = data.arguments?.["torrent-duplicate"] as
    | { id: number; name: string; hashString: string }
    | undefined;
  const torrent = added ?? duplicate;
  if (!torrent) {
    throw new Error(`unexpected torrent-add response: ${JSON.stringify(data.arguments)}`);
  }
  return { id: torrent.id, name: torrent.name, hashString: torrent.hashString, duplicate: Boolean(duplicate) };
}

export interface TorrentPollResult {
  id: number;
  status: number;
  error: number;
  errorString: string;
}

/**
 * Polls torrent-get for a single torrent id until Transmission reports it
 * (confirming the add was actually registered, not just that the RPC call
 * itself returned success) or the attempts run out. A transient RPC hiccup
 * mid-poll doesn't abort early - it just counts as a miss for that attempt.
 */
export async function pollTorrentAdded(
  config: TransmissionConfig,
  id: number,
  { attempts = 5, intervalMs = 1000, timeoutMs = 3000 }: { attempts?: number; intervalMs?: number; timeoutMs?: number } = {}
): Promise<TorrentPollResult | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const data = await rpcCall(
        config,
        "torrent-get",
        { ids: [id], fields: ["id", "status", "error", "errorString"] },
        timeoutMs
      );
      const torrents = (data.arguments?.torrents ?? []) as TorrentPollResult[];
      const match = torrents.find((t) => t.id === id);
      if (match) return match;
    } catch {
      // Keep polling - a single failed attempt doesn't mean Transmission
      // rejected the torrent, and the caller already knows torrent-add
      // itself succeeded.
    }
  }
  return null;
}

// From Transmission's RPC spec (tr_torrent_activity): 1 = queued to check
// existing data, 2 = actively checking it - the two states a torrent added
// against a directory with existing files passes through before its own
// piece-hash verify has actually settled.
const STATUS_CHECK_WAIT = 1;
const STATUS_CHECKING = 2;

export interface TorrentVerifyResult {
  id: number;
  status: number;
  error: number;
  errorString: string;
  /** 0-1 fraction Transmission reports as already verified/downloaded - the authoritative measure of whether a staged reseed match was actually correct (see reseed.ts and reseedMatch.ts's own, unverified size-only matching). */
  percentDone: number;
}

/**
 * Polls torrent-get until a freshly-added torrent's own verify pass (see
 * STATUS_CHECK_WAIT/STATUS_CHECKING above) has settled, then returns the
 * result - including percentDone, so a caller can tell a clean full verify
 * from a partial or zero one. Used by the reseed-from-library flow
 * (reseed.ts) after adding a torrent pointed at freshly staged files;
 * unlike pollTorrentAdded (which only confirms the add was registered at
 * all), this deliberately waits out the hash-check itself, since that's the
 * whole point of staging files ahead of the add. If attempts run out before
 * settling, the last-seen (still-checking) result is returned rather than
 * null, so a caller can at least report "still verifying" instead of
 * mistaking a slow check for a failed one.
 */
export async function pollTorrentVerification(
  config: TransmissionConfig,
  id: number,
  { attempts = 30, intervalMs = 2000, timeoutMs = 5000 }: { attempts?: number; intervalMs?: number; timeoutMs?: number } = {}
): Promise<TorrentVerifyResult | null> {
  let last: TorrentVerifyResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const data = await rpcCall(
        config,
        "torrent-get",
        { ids: [id], fields: ["id", "status", "error", "errorString", "percentDone"] },
        timeoutMs
      );
      const torrents = (data.arguments?.torrents ?? []) as TorrentVerifyResult[];
      const match = torrents.find((t) => t.id === id);
      if (match) {
        last = match;
        if (match.status !== STATUS_CHECK_WAIT && match.status !== STATUS_CHECKING) return match;
      }
    } catch {
      // Keep polling - a single failed attempt doesn't mean verification failed.
    }
  }
  return last;
}

/**
 * Unpauses a torrent via RPC `torrent-start` - used by the reseed-from-
 * library flow (reseed.ts) once pollTorrentVerification confirms a clean,
 * complete verify, so a fully-matched reseed actually starts seeding
 * instead of sitting paused until someone notices and clicks Start in
 * Transmission's own UI. Throws on failure, same as the other RPC calls
 * here - callers decide how to surface that (reseed.ts treats a failure to
 * start as non-fatal: the torrent is still correctly staged and verified,
 * just left paused, and the caller can start it manually).
 */
export async function startTorrent(config: TransmissionConfig, id: number, timeoutMs = 5000): Promise<void> {
  await rpcCall(config, "torrent-start", { ids: [id] }, timeoutMs);
}

/** One entry of RPC `torrent-get`'s `files` field - `name` is already the full path relative to the torrent's own download-dir (i.e. it includes the torrent's top-level name/folder for a multi-file torrent), the same convention torrentFile.ts's `relativePath` uses. */
export interface TransmissionFileEntry {
  name: string;
  length: number;
  bytesCompleted: number;
}

export interface TransmissionTorrentDetail {
  id: number;
  name: string;
  status: number;
  percentDone: number;
  files: TransmissionFileEntry[];
}

/**
 * Fetches every torrent Transmission currently knows about, with its full
 * file list and sizes - used by src/seeding.ts to size-match each one
 * against the library without needing that torrent's original .torrent
 * file at all (Transmission already has this information for anything
 * it's managing, reseeded through this app or not). Omitting `ids` from
 * the RPC args is what makes this return every torrent rather than a
 * specific one.
 */
export async function getAllTorrentsWithFiles(
  config: TransmissionConfig,
  timeoutMs = 10000
): Promise<TransmissionTorrentDetail[]> {
  const data = await rpcCall(
    config,
    "torrent-get",
    { fields: ["id", "name", "status", "percentDone", "files"] },
    timeoutMs
  );
  return (data.arguments?.torrents ?? []) as TransmissionTorrentDetail[];
}

export interface TorrentLocation {
  name: string;
  downloadDir: string;
}

/**
 * Looks up where Transmission actually has a torrent's data on disk right
 * now - used by the "Add to Plex library" action on the Currently seeding
 * list (see reseedApi.ts) to feed the torrent's real, current dir/name
 * into the same handleTorrentDone pipeline the webhook uses, for a torrent
 * Transmission is seeding but that never went through Domestique's normal
 * ingestion (or whose library copy is missing/gone). Deliberately re-fetched
 * fresh from Transmission server-side rather than trusting a client-supplied
 * path - `dir`/`name` end up feeding a filesystem copy operation, so this
 * is the one source of truth for them. Returns null if Transmission doesn't
 * report a torrent with this id at all (removed, wrong id, etc).
 */
export async function getTorrentLocation(
  config: TransmissionConfig,
  id: number,
  timeoutMs = 5000
): Promise<TorrentLocation | null> {
  const data = await rpcCall(config, "torrent-get", { ids: [id], fields: ["id", "name", "downloadDir"] }, timeoutMs);
  const torrents = (data.arguments?.torrents ?? []) as Array<{ id: number; name: string; downloadDir: string }>;
  const match = torrents.find((t) => t.id === id);
  return match ? { name: match.name, downloadDir: match.downloadDir } : null;
}
