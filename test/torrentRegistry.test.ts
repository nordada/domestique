import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerTorrent,
  isRegistered,
  listRegistry,
  getRegisteredTorrentBuf,
} from "../src/torrentRegistry.js";

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "domestique-torrent-registry-"));
}

// Fake but validly-shaped (40-char lowercase hex) info-hashes, matching what
// bencode.ts's computeInfoHash would actually produce - the registry itself
// never validates the shape (it's dumb byte storage keyed by whatever
// string it's given), so these are just readable stand-ins for real hashes.
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

test("registerTorrent + isRegistered + getRegisteredTorrentBuf: round-trips a saved .torrent", async () => {
  const dir = await scratchDir();
  const buf = Buffer.from("fake torrent bytes");
  await registerTorrent(HASH_A, buf, dir);

  assert.equal(await isRegistered(HASH_A, dir), true);
  assert.deepEqual(await getRegisteredTorrentBuf(HASH_A, dir), buf);
});

test("isRegistered: returns false for a hash that was never registered", async () => {
  const dir = await scratchDir();
  assert.equal(await isRegistered(HASH_A, dir), false);
});

test("getRegisteredTorrentBuf: returns null for a hash that was never registered", async () => {
  const dir = await scratchDir();
  assert.equal(await getRegisteredTorrentBuf(HASH_A, dir), null);
});

test("registerTorrent: creates the registry directory on first use rather than requiring it to pre-exist", async () => {
  const parent = await scratchDir();
  const dir = join(parent, "torrent-registry");
  await assert.rejects(fs.stat(dir));

  await registerTorrent(HASH_A, Buffer.from("bytes"), dir);
  assert.ok((await fs.stat(dir)).isDirectory());
});

test("registerTorrent: registering the same hash again overwrites the old bytes", async () => {
  const dir = await scratchDir();
  await registerTorrent(HASH_A, Buffer.from("first"), dir);
  await registerTorrent(HASH_A, Buffer.from("second"), dir);

  assert.deepEqual(await getRegisteredTorrentBuf(HASH_A, dir), Buffer.from("second"));
});

test("listRegistry: returns an empty array when the registry directory doesn't exist yet, rather than throwing", async () => {
  const parent = await scratchDir();
  const dir = join(parent, "never-created");
  assert.deepEqual(await listRegistry(dir), []);
});

test("listRegistry: lists every registered torrent's hash/size, ignoring non-.torrent files", async () => {
  const dir = await scratchDir();
  await registerTorrent(HASH_A, Buffer.alloc(100), dir);
  await registerTorrent(HASH_B, Buffer.alloc(250), dir);
  await fs.writeFile(join(dir, "not-a-torrent.txt"), "junk");

  const entries = await listRegistry(dir);
  entries.sort((a, b) => a.infoHash.localeCompare(b.infoHash));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].infoHash, HASH_A);
  assert.equal(entries[0].sizeBytes, 100);
  assert.equal(entries[1].infoHash, HASH_B);
  assert.equal(entries[1].sizeBytes, 250);
  assert.ok(entries[0].addedAt);
});

test("a hash that would resolve outside the registry directory is refused, not silently confined", async () => {
  const dir = await scratchDir();
  // Path traversal via the hash itself - registerTorrent must refuse to
  // write outside `dir`, the same "confine before touching the filesystem"
  // discipline every other client-supplied path in this app already follows.
  await assert.rejects(() => registerTorrent("../../etc/passwd", Buffer.from("x"), dir));

  // The read-side helpers fail closed (return false/null) instead of
  // throwing, since a malformed hash reaching them is client input off an
  // HTTP request (the download route), not a programming error to crash on.
  assert.equal(await isRegistered("../../etc/passwd", dir), false);
  assert.equal(await getRegisteredTorrentBuf("../../etc/passwd", dir), null);
});
