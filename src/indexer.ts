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

/** Cheap reachability probe - a plain GET rather than HEAD, since indexer/tracker sites are often fronted by Cloudflare or similar and commonly reject HEAD. Stateless: callers that want to throttle how often this actually runs (see webui.ts's /api/status) cache the result themselves. */
export async function checkIndexerLive(config: { url: string }, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(config.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) console.warn(`[indexer] ${config.url} responded ${res.status} ${res.statusText}`);
    return res.ok;
  } catch (err) {
    console.warn(`[indexer] failed to reach ${config.url}: ${err}`);
    return false;
  }
}
