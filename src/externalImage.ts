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

import { assertPublicHostname } from "./ssrfGuard.js";

const USER_AGENT = "Domestique/1.0 (+https://github.com/nordada/domestique)";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 15_000_000;
const MAX_REDIRECTS = 5;

/**
 * Fetches an arbitrary user-pasted image URL server-side - the general
 * counterpart to wikimediaCommons.ts's fetchCommonsFile, which is
 * deliberately locked to Wikimedia's own host. This one has to accept any
 * http(s) URL by design (that's the point of "paste a URL you found
 * yourself"), so the safety burden sits entirely on hostCheck (defaults to
 * the real assertPublicHostname): every hop (the original URL and every
 * redirect target) is validated before being fetched, not just the first
 * one - a redirect is exactly how an otherwise-blocked internal fetch
 * could be smuggled through if only the initial host were checked. See
 * assertPublicHostname's own doc comment for the one gap this doesn't
 * close (DNS rebinding).
 *
 * `hostCheck` exists purely for tests - the real SSRF guard necessarily
 * blocks 127.0.0.1/loopback, which is exactly where a local stub server
 * binds, so exercising this function's actual fetch/redirect/byte-cap
 * logic against a stub needs a way to substitute a permissive check for
 * that one address while still real-checking everything else (e.g. a
 * redirect target) - see externalImage.test.ts. Production code never
 * passes this.
 */
export async function fetchExternalImage(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; hostCheck?: (hostname: string) => Promise<void> } = {}
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hostCheck = opts.hostCheck ?? assertPublicHostname;

  let current = new URL(rawUrl);
  for (let redirectCount = 0; ; redirectCount++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`unsupported URL scheme: ${current.protocol}`);
    }
    await hostCheck(current.hostname);

    const res = await fetch(current.toString(), {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`redirect response (${res.status}) had no Location header`);
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new Error(`too many redirects (over ${MAX_REDIRECTS})`);
      }
      current = new URL(location, current);
      continue;
    }

    if (!res.ok) {
      throw new Error(`fetch returned ${res.status} ${res.statusText}`);
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
}
