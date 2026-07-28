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
 * read a .torrent's name/file-list/sizes. No encoder (nothing here ever
 * produces bencode) and no preservation of raw byte spans (nothing here
 * computes a torrent's infohash - Transmission is handed the original,
 * untouched file bytes in src/transmission.ts and computes its own).
 */

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
