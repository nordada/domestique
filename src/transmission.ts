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
  timeoutMs = 10000
): Promise<AddedTorrent> {
  const data = await rpcCall(config, "torrent-add", { metainfo: metainfoBase64 }, timeoutMs);
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
