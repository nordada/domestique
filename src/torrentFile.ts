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

import { decodeBencode, type BencodeValue } from "./bencode.js";

/** relativePath already includes the torrent's info.name as its first segment, so every caller can treat single- and multi-file torrents identically - it's exactly the path Transmission's download-dir + this path should resolve to. */
export interface TorrentFileEntry {
  relativePath: string;
  length: number;
}

export interface TorrentMetainfo {
  name: string;
  files: TorrentFileEntry[];
}

export class TorrentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorrentParseError";
  }
}

function asDict(value: BencodeValue | undefined, context: string): Map<string, BencodeValue> {
  if (!(value instanceof Map)) throw new TorrentParseError(`torrent file: expected a dict for ${context}`);
  return value;
}

function asBuffer(value: BencodeValue | undefined, context: string): Buffer {
  if (!Buffer.isBuffer(value)) throw new TorrentParseError(`torrent file: expected a string for ${context}`);
  return value;
}

function asNumber(value: BencodeValue | undefined, context: string): number {
  if (typeof value !== "number") throw new TorrentParseError(`torrent file: expected an integer for ${context}`);
  return value;
}

function asList(value: BencodeValue | undefined, context: string): BencodeValue[] {
  if (!Array.isArray(value)) throw new TorrentParseError(`torrent file: expected a list for ${context}`);
  return value;
}

// A .torrent is untrusted external input (same trust class as a web-UI
// upload's client-supplied name - see upload.ts's sanitizeName), so every
// path segment is validated before it's ever joined into a filesystem path.
// Checked per-segment rather than via path.basename(), which would silently
// collapse a multi-segment traversal attempt (e.g. "../../etc") into a
// harmless-looking single component instead of rejecting it outright.
const INVALID_SEGMENT_RE = /[\\/]|\0/;

function sanitizePathSegment(raw: string, context: string): string {
  if (!raw || raw === "." || raw === "..") {
    throw new TorrentParseError(`torrent file: invalid path segment "${raw}" in ${context}`);
  }
  if (INVALID_SEGMENT_RE.test(raw)) {
    throw new TorrentParseError(
      `torrent file: path segment "${raw}" in ${context} contains a path separator or NUL byte`
    );
  }
  return raw;
}

/**
 * Reads just enough of a .torrent's info dict to know its expected file
 * layout: name, and either a single length (BEP 3 single-file) or a list of
 * {path, length} entries (BEP 3 multi-file). Hybrid v1+v2 torrents (BEP 52)
 * parse fine here, since they still carry these v1 fields for backward
 * compatibility - "meta version" is simply ignored. Pure v2-only torrents
 * (no v1 fields at all, just a "file tree" dict) are rejected outright with
 * a clear error rather than silently mis-parsed into a bogus file list.
 */
export function parseTorrentFile(buf: Buffer): TorrentMetainfo {
  let root: BencodeValue;
  try {
    root = decodeBencode(buf);
  } catch (err) {
    throw new TorrentParseError(`torrent file is not valid bencode: ${err}`);
  }

  const rootDict = asDict(root, "the torrent file's root");
  const infoValue = rootDict.get("info");
  if (infoValue === undefined) throw new TorrentParseError("torrent file: missing info dict");
  const info = asDict(infoValue, "info");

  const nameValue = info.get("name");
  if (nameValue === undefined) throw new TorrentParseError("torrent file: missing info.name");
  const name = sanitizePathSegment(asBuffer(nameValue, "info.name").toString("utf-8"), "info.name");

  const filesValue = info.get("files");
  const lengthValue = info.get("length");

  if (filesValue !== undefined) {
    const files = asList(filesValue, "info.files").map((entry, index) => {
      const entryDict = asDict(entry, `info.files[${index}]`);
      const length = asNumber(entryDict.get("length"), `info.files[${index}].length`);
      const pathList = asList(entryDict.get("path"), `info.files[${index}].path`);
      if (pathList.length === 0) {
        throw new TorrentParseError(`torrent file: info.files[${index}].path is empty`);
      }
      const segments = pathList.map((seg, segIndex) =>
        sanitizePathSegment(
          asBuffer(seg, `info.files[${index}].path[${segIndex}]`).toString("utf-8"),
          `info.files[${index}].path[${segIndex}]`
        )
      );
      return { relativePath: [name, ...segments].join("/"), length };
    });
    return { name, files };
  }

  if (lengthValue !== undefined) {
    const length = asNumber(lengthValue, "info.length");
    return { name, files: [{ relativePath: name, length }] };
  }

  throw new TorrentParseError(
    "torrent file has neither info.length nor info.files - likely a BitTorrent v2-only torrent (not supported by this parser); a hybrid v1+v2 torrent is fine, since it still carries the v1 fields read here"
  );
}
