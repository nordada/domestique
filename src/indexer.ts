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

// Plenty of tracker/indexer sites run basic bot filtering that silently
// drops (not even a 403 - just no response, so the request hangs until it
// times out) any request without a normal-looking browser User-Agent.
// Node's fetch sends none by default, which reads as "down" against a site
// that's actually fine - confirmed against cyclingarchive.club, where a bare
// `fetch()` timed out every time but adding this header got an instant 200.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Cheap reachability probe - a plain GET rather than HEAD, since
 * indexer/tracker sites are often fronted by Cloudflare or similar and
 * commonly reject HEAD. Stateless: callers that want to throttle how often
 * this actually runs (see webui.ts's /api/status) cache the result
 * themselves.
 *
 * Only ever probes the site's origin, not whatever path/query the
 * configured URL happens to carry - a bookmarked deep link (e.g. a
 * browse.php search) commonly needs an authenticated session to load and
 * would always read as "down" even while the site itself is fine, so the
 * health check deliberately checks the domain root instead of the exact
 * page the gauge links to.
 */
export async function checkIndexerLive(config: { url: string }, timeoutMs = 3000): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(config.url).origin;
  } catch (err) {
    console.warn(`[indexer] invalid URL ${config.url}: ${err}`);
    return false;
  }
  try {
    const res = await fetch(origin, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) console.warn(`[indexer] ${origin} responded ${res.status} ${res.statusText}`);
    return res.ok;
  } catch (err) {
    console.warn(`[indexer] failed to reach ${origin}: ${err}`);
    return false;
  }
}
