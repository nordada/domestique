import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBencode } from "../src/bencode.js";

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
