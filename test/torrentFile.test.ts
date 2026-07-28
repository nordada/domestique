import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTorrentFile, TorrentParseError } from "../src/torrentFile.js";
import {
  buildSingleFileTorrent,
  buildMultiFileTorrent,
  buildHybridTorrent,
  buildV2OnlyTorrent,
  encodeBencode,
} from "./torrentFixtures.js";

test("parseTorrentFile parses a single-file torrent", () => {
  const buf = buildSingleFileTorrent("Tour de France Stage 5.mp4", 123456);
  const meta = parseTorrentFile(buf);
  assert.equal(meta.name, "Tour de France Stage 5.mp4");
  assert.deepEqual(meta.files, [{ relativePath: "Tour de France Stage 5.mp4", length: 123456 }]);
});

test("parseTorrentFile parses a multi-file torrent, prefixing each path with info.name", () => {
  const buf = buildMultiFileTorrent("Tour de France 2026", [
    { path: ["Stage 1.mp4"], length: 111 },
    { path: ["subs", "Stage 1.srt"], length: 22 },
  ]);
  const meta = parseTorrentFile(buf);
  assert.equal(meta.name, "Tour de France 2026");
  assert.deepEqual(meta.files, [
    { relativePath: "Tour de France 2026/Stage 1.mp4", length: 111 },
    { relativePath: "Tour de France 2026/subs/Stage 1.srt", length: 22 },
  ]);
});

test("parseTorrentFile accepts a hybrid v1+v2 torrent via its v1 fields", () => {
  const buf = buildHybridTorrent("Paris-Roubaix.mp4", 999);
  const meta = parseTorrentFile(buf);
  assert.equal(meta.name, "Paris-Roubaix.mp4");
  assert.deepEqual(meta.files, [{ relativePath: "Paris-Roubaix.mp4", length: 999 }]);
});

test("parseTorrentFile rejects a pure v2-only torrent", () => {
  const buf = buildV2OnlyTorrent("Paris-Roubaix.mp4");
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});

test("parseTorrentFile rejects non-bencode input", () => {
  assert.throws(() => parseTorrentFile(Buffer.from("not a torrent")), TorrentParseError);
});

test("parseTorrentFile rejects a torrent missing info.name", () => {
  const buf = encodeBencode({ info: { length: 10, "piece length": 1, pieces: "" } });
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});

test("parseTorrentFile rejects a '..' path segment (path traversal attempt)", () => {
  const buf = buildMultiFileTorrent("Race", [{ path: ["..", "..", "etc", "passwd"], length: 10 }]);
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});

test("parseTorrentFile rejects a path segment containing a slash", () => {
  const buf = buildMultiFileTorrent("Race", [{ path: ["sneaky/traversal.mp4"], length: 10 }]);
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});

test("parseTorrentFile rejects an info.name that is itself '..'", () => {
  const buf = buildSingleFileTorrent("..", 10);
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});

test("parseTorrentFile rejects a torrent missing the info dict entirely", () => {
  const buf = encodeBencode({ announce: "http://example.invalid" });
  assert.throws(() => parseTorrentFile(buf), TorrentParseError);
});
