import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeBencode, computeInfoHash } from "../src/bencode.js";

test("decodeBencode decodes a positive integer", () => {
  assert.equal(decodeBencode(Buffer.from("i42e")), 42);
});

test("decodeBencode decodes a negative integer", () => {
  assert.equal(decodeBencode(Buffer.from("i-3e")), -3);
});

test("decodeBencode decodes a byte string as a Buffer", () => {
  const result = decodeBencode(Buffer.from("4:spam"));
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString("utf-8"), "spam");
});

test("decodeBencode decodes a list of strings", () => {
  const result = decodeBencode(Buffer.from("l4:spam4:eggse")) as Buffer[];
  assert.equal(result.length, 2);
  assert.equal(result[0].toString("utf-8"), "spam");
  assert.equal(result[1].toString("utf-8"), "eggs");
});

test("decodeBencode decodes a dict (the classic bencode spec example)", () => {
  const result = decodeBencode(Buffer.from("d3:cow3:moo4:spam4:eggse")) as Map<string, Buffer>;
  assert.equal(result.get("cow")?.toString("utf-8"), "moo");
  assert.equal(result.get("spam")?.toString("utf-8"), "eggs");
});

test("decodeBencode decodes nested lists/dicts", () => {
  const result = decodeBencode(Buffer.from("d4:listl1:a1:beee")) as Map<string, unknown>;
  const list = result.get("list") as Buffer[];
  assert.equal(list.length, 2);
  assert.equal(list[0].toString("utf-8"), "a");
  assert.equal(list[1].toString("utf-8"), "b");
});

test("decodeBencode throws on a truncated integer", () => {
  assert.throws(() => decodeBencode(Buffer.from("i42")));
});

test("decodeBencode throws on an invalid integer body", () => {
  assert.throws(() => decodeBencode(Buffer.from("i4x2e")));
});

test("decodeBencode throws on an unterminated list", () => {
  assert.throws(() => decodeBencode(Buffer.from("l4:spam")));
});

test("decodeBencode throws on an unterminated dict", () => {
  assert.throws(() => decodeBencode(Buffer.from("d3:cow3:moo")));
});

test("decodeBencode throws on a string length exceeding the buffer", () => {
  assert.throws(() => decodeBencode(Buffer.from("10:short")));
});

test("decodeBencode throws on an unrecognized leading byte", () => {
  assert.throws(() => decodeBencode(Buffer.from("x42e")));
});

test("decodeBencode throws on empty input", () => {
  assert.throws(() => decodeBencode(Buffer.alloc(0)));
});

test("computeInfoHash matches an independently-computed SHA1 of the raw info dict bytes", () => {
  // A hand-assembled torrent, deliberately with the "info" key NOT first
  // (a real .torrent can order its top-level keys any way it likes) -
  // computeInfoHash must find "info" wherever it sits and hash exactly its
  // raw byte span, not a re-encoded structure.
  const infoBytes = Buffer.from("d6:lengthi100e4:name5:hello12:piece lengthi262144e6:pieces0:e");
  const expected = createHash("sha1").update(infoBytes).digest("hex");

  const torrentBytes = Buffer.concat([
    Buffer.from("d8:announce22:http://example.invalid13:creation datei0e4:info"),
    infoBytes,
    Buffer.from("e"),
  ]);

  assert.equal(computeInfoHash(torrentBytes), expected);
});

test("computeInfoHash: different info dict content produces a different hash", () => {
  const buildTorrent = (length: number) =>
    Buffer.concat([
      Buffer.from("d8:announce22:http://example.invalid4:info"),
      Buffer.from(`d6:lengthi${length}e4:name5:hello12:piece lengthi262144e6:pieces0:e`),
      Buffer.from("e"),
    ]);
  assert.notEqual(computeInfoHash(buildTorrent(100)), computeInfoHash(buildTorrent(200)));
});

test("computeInfoHash: identical content produces the identical hash (self-consistency)", () => {
  const torrentBytes = Buffer.from("d8:announce13:http://x.test4:infod6:lengthi5e4:name1:a12:piece lengthi1e6:pieces0:ee");
  assert.equal(computeInfoHash(torrentBytes), computeInfoHash(Buffer.from(torrentBytes)));
});

test("computeInfoHash throws when the torrent has no top-level info key", () => {
  assert.throws(() => computeInfoHash(Buffer.from("d8:announce13:http://x.teste")));
});

test("computeInfoHash throws when the root isn't a dict", () => {
  assert.throws(() => computeInfoHash(Buffer.from("i42e")));
});
