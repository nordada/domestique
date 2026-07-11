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
 * to retry with, even when credentials are otherwise valid. A successful
 * "session-get" round-trip on the retry is treated as "live".
 */
export async function checkTransmissionLive(config: TransmissionConfig, timeoutMs = 3000): Promise<boolean> {
  const headers = { "Content-Type": "application/json", ...authHeader(config) };
  const body = JSON.stringify({ method: "session-get" });
  try {
    const first = await fetch(config.url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    let res = first;
    if (first.status === 409) {
      const sessionId = first.headers.get("x-transmission-session-id");
      if (!sessionId) {
        console.warn(`[transmission] ${config.url} returned 409 without an X-Transmission-Session-Id header`);
        return false;
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
      console.warn(`[transmission] ${config.url} responded ${res.status} ${res.statusText}`);
      return false;
    }
    const data = (await res.json()) as { result?: string };
    if (data.result !== "success") {
      console.warn(`[transmission] ${config.url} responded with result "${data.result}"`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[transmission] failed to reach ${config.url}: ${err}`);
    return false;
  }
}
