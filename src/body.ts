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

import type { IncomingMessage } from "node:http";

/**
 * Buffered request-body readers, shared by server.ts and webui.ts, with a
 * hard size cap so an oversized (or deliberately endless) body can't
 * accumulate unbounded memory. These are only for bodies that are small by
 * nature: JSON route payloads and .torrent files. The video upload path
 * (upload.ts) deliberately does NOT come through here; it streams straight
 * to disk via pipeline and legitimately handles multi-gigabyte bodies.
 */

/** JSON route payloads: the largest real one is the full events config (tens of KB), so 1 MB is generous headroom. */
export const JSON_BODY_LIMIT_BYTES = 1_000_000;

/** .torrent metainfo files: rarely more than a few hundred KB even for huge multi-file torrents, so 10 MB is generous. */
export const TORRENT_BODY_LIMIT_BYTES = 10_000_000;

/** Handlers map this to a 413 response; the message is deliberately safe to echo to the client. */
export class BodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`request body exceeds the ${limitBytes} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

/** Binary-safe reader: string concatenation of raw chunks would corrupt a .torrent file's bencoded bytes. */
export function readBodyBuffer(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        // Stop consuming and settle the promise; the handler's 413 response
        // (with Connection: close) tells the client to stop sending. The
        // stream itself is left alone so the response can still be written.
        req.off("data", onData);
        req.pause();
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function readBody(req: IncomingMessage, limitBytes: number = JSON_BODY_LIMIT_BYTES): Promise<string> {
  return readBodyBuffer(req, limitBytes).then((buf) => buf.toString("utf-8"));
}
