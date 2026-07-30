import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyRegistryEntries } from "../src/torrentRegistryMigration.js";
import { listRegistry, registerTorrent } from "../src/torrentRegistry.js";
import { parseTorrentFile } from "../src/torrentFile.js";
import { buildSingleFileTorrent } from "./torrentFixtures.js";

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "domestique-registry-migration-"));
}

test("migrateLegacyRegistryEntries: renames a legacy name-keyed file to its real hash when nothing's registered under that hash yet", async () => {
  const dir = await scratchDir();
  const buf = buildSingleFileTorrent("Legacy-Only-Torrent", 1000);
  const infoHash = parseTorrentFile(buf).infoHash;
  // Simulates the real incident: a file saved under the OLD name-keyed
  // scheme, before the registry became hash-keyed.
  await fs.writeFile(join(dir, "Legacy-Only-Torrent.torrent"), buf);

  const result = await migrateLegacyRegistryEntries(dir);
  assert.deepEqual(result, { migrated: 1, removed: 0 });

  const entries = await listRegistry(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].infoHash, infoHash);
  await assert.rejects(fs.stat(join(dir, "Legacy-Only-Torrent.torrent")));
});

test(
  "migrateLegacyRegistryEntries: deletes a legacy duplicate outright when a correctly hash-keyed copy of the identical content already exists - reproduces the real incident (904 vs. 634 double-counted torrents)",
  async () => {
    const dir = await scratchDir();
    const buf = buildSingleFileTorrent("TdF-2021-Stage-03", 6401256143);
    const infoHash = parseTorrentFile(buf).infoHash;

    // The legacy name-keyed file (from the old registry scheme)...
    await fs.writeFile(join(dir, "TdF-2021-Stage-03.torrent"), buf);
    // ...and the correctly hash-keyed re-registration of the SAME content
    // (as the autobrr-capture sync would produce once it re-discovered the
    // same torrent in Transmission's own torrents directory).
    await registerTorrent(infoHash, buf, dir);

    assert.equal((await listRegistry(dir)).length, 2); // both present before migration

    const result = await migrateLegacyRegistryEntries(dir);
    assert.deepEqual(result, { migrated: 0, removed: 1 });

    const entries = await listRegistry(dir);
    assert.equal(entries.length, 1); // the duplicate is gone, only the real hash-keyed copy remains
    assert.equal(entries[0].infoHash, infoHash);
  }
);

test("migrateLegacyRegistryEntries: leaves already-correctly-hash-keyed entries alone", async () => {
  const dir = await scratchDir();
  const buf = buildSingleFileTorrent("Already Correct", 500);
  const infoHash = parseTorrentFile(buf).infoHash;
  await registerTorrent(infoHash, buf, dir);

  const result = await migrateLegacyRegistryEntries(dir);
  assert.deepEqual(result, { migrated: 0, removed: 0 });
  assert.equal((await listRegistry(dir)).length, 1);
});

test("migrateLegacyRegistryEntries: a legacy file that no longer parses cleanly is skipped, not fatal to the rest of the pass", async () => {
  const dir = await scratchDir();
  await fs.writeFile(join(dir, "corrupt-legacy.torrent"), "not valid bencode at all");
  const goodBuf = buildSingleFileTorrent("Legacy-Good", 42);
  await fs.writeFile(join(dir, "Legacy-Good.torrent"), goodBuf);

  const result = await migrateLegacyRegistryEntries(dir);
  assert.equal(result.migrated, 1); // only the parseable one migrated
  assert.equal(result.removed, 0);

  const entries = await listRegistry(dir);
  const stems = entries.map((e) => e.infoHash);
  assert.ok(stems.includes(parseTorrentFile(goodBuf).infoHash));
  // The corrupt file is still sitting there under its original (non-hash) name - left alone, not deleted, since we can't determine its real identity.
  await assert.doesNotReject(fs.stat(join(dir, "corrupt-legacy.torrent")));
});

test("migrateLegacyRegistryEntries: returns zero counts and doesn't throw when the registry directory doesn't exist yet", async () => {
  const parent = await scratchDir();
  const dir = join(parent, "never-created");
  const result = await migrateLegacyRegistryEntries(dir);
  assert.deepEqual(result, { migrated: 0, removed: 0 });
});

test("migrateLegacyRegistryEntries: multiple distinct legacy files all migrate correctly in one pass", async () => {
  const dir = await scratchDir();
  const bufA = buildSingleFileTorrent("Legacy-A", 10);
  const bufB = buildSingleFileTorrent("Legacy-B", 20);
  await fs.writeFile(join(dir, "Legacy-A.torrent"), bufA);
  await fs.writeFile(join(dir, "Legacy-B.torrent"), bufB);

  const result = await migrateLegacyRegistryEntries(dir);
  assert.deepEqual(result, { migrated: 2, removed: 0 });

  const stems = (await listRegistry(dir)).map((e) => e.infoHash).sort();
  assert.deepEqual(stems, [parseTorrentFile(bufA).infoHash, parseTorrentFile(bufB).infoHash].sort());
});
