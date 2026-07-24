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
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
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

interface WikipediaSearchPage {
  title?: string;
  thumbnail?: { source?: string };
  original?: { source?: string };
}

export interface CommonsSearchResponse {
  results: CommonsSearchResult[];
  /**
   * Whether this came from the fallback Commons File-namespace search
   * rather than the primary Wikipedia-article-image attempt - see
   * searchCommonsLogos's doc comment for why that matters. The web UI
   * surfaces this so a user seeing odd results understands why, rather
   * than assuming Domestique's own logic picked a bad result.
   */
  broadened: boolean;
}

// Requested well above the number of results actually shown (see
// searchCommonsLogos's `limit` param) - most Wikipedia articles matching a
// race query (individual year editions, "X Women", etc.) have NO page
// image at all, so a raw search needs a much bigger pool to find enough
// candidates that do. Verified live: an intitle-scoped "Milan-San Remo"
// search found its first image-bearing article only at position 12+ of the
// raw (unfiltered) result list.
const WIKIPEDIA_RAW_FETCH_LIMIT = 30;

/**
 * Runs one Wikipedia article search for `gsrsearch` and returns every
 * matching article that actually has a "page image" - the single
 * representative image MediaWiki's PageImages extension picks for a page,
 * almost always its infobox image. Articles with no page image at all
 * (common for minor one-off event pages, e.g. a single year's edition with
 * only a route-map image or none) are skipped outright rather than
 * returned with an empty thumbnail. Shared by both the title-scoped and
 * broad Wikipedia attempts in searchCommonsLogos - only the raw
 * `gsrsearch` value differs between them.
 */
async function searchWikipediaArticleImages(gsrsearch: string, apiUrl: string): Promise<CommonsSearchResult[]> {
  const url = new URL(apiUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", gsrsearch);
  url.searchParams.set("gsrnamespace", "0"); // articles only, not Talk/User/etc
  url.searchParams.set("gsrlimit", String(WIKIPEDIA_RAW_FETCH_LIMIT));
  url.searchParams.set("prop", "pageimages");
  url.searchParams.set("piprop", "thumbnail|original");
  url.searchParams.set("pithumbsize", "200");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikipedia search returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { query?: { pages?: Record<string, WikipediaSearchPage> } };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  const results: CommonsSearchResult[] = [];
  for (const page of pages) {
    const original = page.original?.source;
    if (!page.title || !original) continue;
    results.push({ title: page.title, fileUrl: original, thumbUrl: page.thumbnail?.source ?? original });
  }
  return results;
}

async function runCommonsSearch(gsrsearch: string, limit: number, apiUrl: string): Promise<CommonsSearchResult[]> {
  const url = new URL(apiUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", gsrsearch);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(limit));
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

/** `intitle:word1 intitle:word2 ...` - requires every query word to actually appear in the result's own title, not just anywhere in its full text/metadata. Shared by both the Wikipedia and Commons title-scoped tiers below. */
function titleScopedQuery(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).map((w) => `intitle:${w}`).join(" ");
}

/**
 * Finds logo candidates for a race, trying four progressively broader (and
 * progressively less precise) sources in order, stopping at the first that
 * finds anything:
 *
 * 1. Wikipedia article search, `intitle:`-scoped (every query word must be
 *    in the article's own title) - real Wikipedia article search, using
 *    each matched article's page image (see searchWikipediaArticleImages).
 *    Title-scoping matters here for the same reason it does on Commons
 *    below: an unscoped query resolves to whatever articles MENTION the
 *    race prominently, which pulls in riders' and teams' own biography
 *    pages (verified live: unscoped "Milan-San Remo" put "Mathieu van der
 *    Poel" and "Wout van Aert" - both real people, both with their own
 *    portrait as a page image - ahead of the race's own year-edition
 *    articles). Title-scoping keeps every result genuinely about the race
 *    itself.
 * 2. Wikipedia article search, unscoped - the fallback for when even
 *    title-scoping finds no article with a usable image at all (small
 *    races may have no title-matching article with a page image within
 *    the raw fetch window). Accepts the "prominent-mention" noise tier 1
 *    avoids, since some candidates beat none.
 * 3. A Commons File-namespace search, `intitle:`-scoped - the fallback for
 *    when NO Wikipedia article (title-scoped or not) had a usable image at
 *    all. Commons' plain full-text search ranks by term frequency across a
 *    file's ENTIRE description/metadata text, not primarily by title, so
 *    an unscoped query regularly surfaces garbage (verified live:
 *    "Milan-San Remo logo" returned old scanned legal PDFs with zero
 *    connection to cycling, since those words happened to appear
 *    somewhere in the documents' own metadata) - title-scoping avoids that
 *    whenever a dedicated logo file actually exists.
 * 4. Commons' plain, unscoped full-text search - the last resort when even
 *    the title-scoped Commons attempt finds nothing (it's fragile too:
 *    apostrophes/diacritics can tokenize differently) - "some noisy
 *    results" beats "no results" as a genuine last resort.
 *
 * `broadened` in the response is true whenever the result came from tier
 * 2, 3, or 4 rather than tier 1, so the web UI can warn that these are
 * less reliable than the primary title-scoped Wikipedia attempt.
 *
 * `apiUrl`/`wikipediaApiUrl` default to the real Commons/Wikipedia APIs and
 * are only ever overridden in tests (pointed at a local stub server), the
 * same "the real endpoint is a parameter with a production-real default"
 * shape PlexConfig.url already uses elsewhere in this app - keeps this
 * fully unit-testable without hitting the actual Wikimedia API from the
 * test suite. `limit` caps how many results are actually returned (the raw
 * Wikipedia fetch itself always requests more than this - see
 * WIKIPEDIA_RAW_FETCH_LIMIT - since most raw matches don't have a usable
 * image at all).
 */
export async function searchCommonsLogos(
  query: string,
  opts: { limit?: number; apiUrl?: string; wikipediaApiUrl?: string } = {}
): Promise<CommonsSearchResponse> {
  const limit = opts.limit ?? 10;
  const apiUrl = opts.apiUrl ?? COMMONS_API_URL;
  const wikipediaApiUrl = opts.wikipediaApiUrl ?? WIKIPEDIA_API_URL;
  const titleScoped = titleScopedQuery(query);

  const wikipediaTitleResults = titleScoped ? await searchWikipediaArticleImages(titleScoped, wikipediaApiUrl) : [];
  if (wikipediaTitleResults.length > 0) {
    return { results: wikipediaTitleResults.slice(0, limit), broadened: false };
  }

  const wikipediaBroadResults = await searchWikipediaArticleImages(query, wikipediaApiUrl);
  if (wikipediaBroadResults.length > 0) {
    return { results: wikipediaBroadResults.slice(0, limit), broadened: true };
  }

  const commonsTitleResults = titleScoped ? await runCommonsSearch(titleScoped, limit, apiUrl) : [];
  if (commonsTitleResults.length > 0) {
    return { results: commonsTitleResults, broadened: true };
  }

  const commonsBroadResults = await runCommonsSearch(query, limit, apiUrl);
  return { results: commonsBroadResults, broadened: true };
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
