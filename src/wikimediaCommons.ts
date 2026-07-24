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

const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";
const COMMONS_UPLOAD_HOST = "upload.wikimedia.org";
// Wikimedia's API etiquette asks for a descriptive User-Agent identifying
// the calling application, rather than a generic/default one.
const USER_AGENT = "Domestique/1.0 (+https://github.com/nordada/domestique)";
const REQUEST_TIMEOUT_MS = 10000;
// Generous compared to LOGO_BODY_LIMIT_BYTES in coverArt.ts (8MB, for
// direct browser uploads) - Commons originals (especially SVGs re-exported
// at high res) can legitimately be larger; the normalize step downstream
// still caps final dimensions regardless of source size.
const MAX_FILE_BYTES = 15_000_000;

export interface CommonsSearchResult {
  title: string;
  thumbUrl: string;
  fileUrl: string;
}

interface CommonsSearchPage {
  title?: string;
  imageinfo?: Array<{ url?: string; thumburl?: string }>;
}

/**
 * Searches Wikimedia Commons' File namespace (gsrnamespace=6), not plain
 * Wikipedia article search - a Commons file title is usually the actual
 * clean logo asset itself (e.g. "File:Tour de France logo.svg"), where a
 * Wikipedia article's own lead/infobox image is just as often a course map
 * or an action photo instead of the event's logo.
 *
 * `apiUrl` defaults to the real Commons API and is only ever overridden in
 * tests (pointed at a local stub server), the same "the real endpoint is a
 * parameter with a production-real default" shape PlexConfig.url already
 * uses elsewhere in this app - keeps this fully unit-testable without
 * hitting the actual Wikimedia API from the test suite.
 */
export async function searchCommonsLogos(
  query: string,
  opts: { limit?: number; apiUrl?: string } = {}
): Promise<CommonsSearchResult[]> {
  const url = new URL(opts.apiUrl ?? COMMONS_API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(opts.limit ?? 8));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url");
  url.searchParams.set("iiurlwidth", "200");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikimedia Commons search returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    query?: { pages?: Record<string, CommonsSearchPage> };
  };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  const results: CommonsSearchResult[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!page.title || !info?.url) continue;
    results.push({ title: page.title, fileUrl: info.url, thumbUrl: info.thumburl ?? info.url });
  }
  return results;
}

/**
 * Fetches a chosen Commons file's raw bytes server-side. Restricted to
 * Wikimedia's own upload host (where Commons actually serves file/thumbnail
 * bytes from) so this can't be repurposed into an open URL-fetch proxy for
 * arbitrary or internal addresses - the caller only ever passes through a
 * fileUrl that itself came from searchCommonsLogos above, but this is
 * enforced here too as the real boundary, not left as an assumption.
 * `allowedHost`/`maxBytes` default to the real upload host and the real
 * size cap, and are only overridden in tests, same reasoning as
 * searchCommonsLogos's `apiUrl` above.
 */
export async function fetchCommonsFile(
  fileUrl: string,
  opts: { allowedHost?: string; maxBytes?: number } = {}
): Promise<Buffer> {
  const parsed = new URL(fileUrl);
  const allowedHost = opts.allowedHost ?? COMMONS_UPLOAD_HOST;
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  if (parsed.hostname !== allowedHost) {
    throw new Error(`refusing to fetch from unexpected host: ${parsed.hostname}`);
  }

  const res = await fetch(parsed.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikimedia file fetch returned ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("empty response body");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`file exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
