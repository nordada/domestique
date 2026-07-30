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

/**
 * Minimal decode-only bencode parser - just enough for src/torrentFile.ts to
 * read a .torrent's name/file-list/sizes, plus computeInfoHash below for its
 * info-hash. No encoder (nothing here ever produces bencode).
 */

import { createHash } from "node:crypto";

export type BencodeValue = Buffer | number | BencodeValue[] | Map<string, BencodeValue>;

const INTEGER_START = 0x69; // 'i'
const LIST_START = 0x6c; // 'l'
const DICT_START = 0x64; // 'd'
const END = 0x65; // 'e'
const COLON = 0x3a; // ':'
const DIGIT_0 = 0x30; // '0'
const DIGIT_9 = 0x39; // '9'

const INTEGER_RE = /^-?\d+$/;
const LENGTH_RE = /^\d+$/;

class Cursor {
  pos = 0;
  constructor(public buf: Buffer) {}
}

export function decodeBencode(buf: Buffer): BencodeValue {
  const cursor = new Cursor(buf);
  return decodeValue(cursor);
}

function decodeValue(c: Cursor): BencodeValue {
  const byte = c.buf[c.pos];
  if (byte === undefined) throw new Error(`bencode: unexpected end of input at offset ${c.pos}`);
  if (byte === INTEGER_START) return decodeInteger(c);
  if (byte === LIST_START) return decodeList(c);
  if (byte === DICT_START) return decodeDict(c);
  if (byte >= DIGIT_0 && byte <= DIGIT_9) return decodeString(c);
  throw new Error(`bencode: unexpected byte 0x${byte.toString(16)} at offset ${c.pos}`);
}

function decodeInteger(c: Cursor): number {
  const end = c.buf.indexOf(END, c.pos);
  if (end === -1) throw new Error(`bencode: unterminated integer at offset ${c.pos}`);
  const text = c.buf.toString("ascii", c.pos + 1, end);
  if (!INTEGER_RE.test(text)) throw new Error(`bencode: invalid integer "${text}" at offset ${c.pos}`);
  c.pos = end + 1;
  return Number(text);
}

function decodeString(c: Cursor): Buffer {
  const colon = c.buf.indexOf(COLON, c.pos);
  if (colon === -1) throw new Error(`bencode: unterminated string length at offset ${c.pos}`);
  const lenText = c.buf.toString("ascii", c.pos, colon);
  if (!LENGTH_RE.test(lenText)) throw new Error(`bencode: invalid string length "${lenText}" at offset ${c.pos}`);
  const len = Number(lenText);
  const start = colon + 1;
  const end = start + len;
  if (end > c.buf.length) throw new Error(`bencode: string length ${len} exceeds buffer at offset ${c.pos}`);
  c.pos = end;
  return c.buf.subarray(start, end);
}

function decodeList(c: Cursor): BencodeValue[] {
  c.pos += 1; // skip 'l'
  const items: BencodeValue[] = [];
  for (;;) {
    if (c.pos >= c.buf.length) throw new Error("bencode: unterminated list");
    if (c.buf[c.pos] === END) {
      c.pos += 1;
      return items;
    }
    items.push(decodeValue(c));
  }
}

function decodeDict(c: Cursor): Map<string, BencodeValue> {
  c.pos += 1; // skip 'd'
  const dict = new Map<string, BencodeValue>();
  for (;;) {
    if (c.pos >= c.buf.length) throw new Error("bencode: unterminated dict");
    if (c.buf[c.pos] === END) {
      c.pos += 1;
      return dict;
    }
    const key = decodeString(c);
    const value = decodeValue(c);
    dict.set(key.toString("utf-8"), value);
  }
}

/**
 * A torrent's info-hash (the same identifier Transmission itself reports as
 * `hashString`) is defined as the SHA1 of the *raw, original bytes* of the
 * top-level "info" dict value - not a re-encoded structure. Re-encoding a
 * decoded value risks producing different bytes than what a real client
 * (including Transmission) hashed if anything about the original file's
 * encoding isn't perfectly canonical, so this walks the root dict with the
 * same low-level cursor the decoder above uses, capturing the exact byte
 * span the "info" value occupies in the source buffer and hashing that
 * slice directly - never touching the decoded (Map/Buffer/number) form.
 */
export function computeInfoHash(buf: Buffer): string {
  const c = new Cursor(buf);
  if (buf[c.pos] !== DICT_START) {
    throw new Error("bencode: expected the torrent file's root to be a dict");
  }
  c.pos += 1;
  for (;;) {
    if (c.pos >= buf.length) throw new Error("bencode: unterminated dict (no top-level \"info\" key found)");
    if (buf[c.pos] === END) throw new Error("bencode: torrent file has no top-level \"info\" key");
    const key = decodeString(c).toString("utf-8");
    if (key === "info") {
      const infoStart = c.pos;
      decodeValue(c); // advances c.pos past the info value without needing its decoded form
      return createHash("sha1").update(buf.subarray(infoStart, c.pos)).digest("hex");
    }
    decodeValue(c); // not the key we want - still must advance past its value
  }
}
