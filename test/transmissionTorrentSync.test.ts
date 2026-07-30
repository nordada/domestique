import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFromTransmissionTorrentsDir } from "../src/transmissionTorrentSync.js";
import { registerTorrent, listRegistry } from "../src/torrentRegistry.js";
import { parseTorrentFile } from "../src/torrentFile.js";
import { buildSingleFileTorrent } from "./torrentFixtures.js";

async function scratchDirs() {
  const transmissionTorrentsDir = await fs.mkdtemp(join(tmpdir(), "domestique-tsync-transmission-"));
  const registryDir = await fs.mkdtemp(join(tmpdir(), "domestique-tsync-registry-"));
  return { transmissionTorrentsDir, registryDir };
}

test("syncFromTransmissionTorrentsDir: returns 0 and does nothing when the directory is null (feature not configured)", async () => {
  const { registryDir } = await scratchDirs();
  try {
    const synced = await syncFromTransmissionTorrentsDir(null, registryDir);
    assert.equal(synced, 0);
    assert.deepEqual(await listRegistry(registryDir), []);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test("syncFromTransmissionTorrentsDir: registers every .torrent found, keyed by its real info-hash - Transmission's own filename is never trusted for identity", async () => {
  const { transmissionTorrentsDir, registryDir } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Autobrr-Added-Race", 12345);
    const meta = parseTorrentFile(torrentBuf);
    // Transmission's own naming convention (name.hash-prefix.torrent) is
    // opaque to the sync - deliberately using a filename that doesn't even
    // resemble the real hash, to prove it's never parsed for identity.
    await fs.writeFile(join(transmissionTorrentsDir, "totally-unrelated-filename.torrent"), torrentBuf);

    const synced = await syncFromTransmissionTorrentsDir(transmissionTorrentsDir, registryDir);
    assert.equal(synced, 1);

    const entries = await listRegistry(registryDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].infoHash, meta.infoHash);
  } finally {
    await fs.rm(transmissionTorrentsDir, { recursive: true, force: true });
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test("syncFromTransmissionTorrentsDir: skips a torrent already registered, without re-writing it", async () => {
  const { transmissionTorrentsDir, registryDir } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Already Registered", 500);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);
    await fs.writeFile(join(transmissionTorrentsDir, "already-registered.torrent"), torrentBuf);

    const synced = await syncFromTransmissionTorrentsDir(transmissionTorrentsDir, registryDir);
    assert.equal(synced, 0);
    assert.equal((await listRegistry(registryDir)).length, 1);
  } finally {
    await fs.rm(transmissionTorrentsDir, { recursive: true, force: true });
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test("syncFromTransmissionTorrentsDir: ignores non-.torrent files and skips (not crashes on) an unparseable .torrent", async () => {
  const { transmissionTorrentsDir, registryDir } = await scratchDirs();
  try {
    await fs.writeFile(join(transmissionTorrentsDir, "readme.txt"), "not a torrent");
    await fs.writeFile(join(transmissionTorrentsDir, "corrupt.torrent"), "not valid bencode");
    const torrentBuf = buildSingleFileTorrent("Valid One", 10);
    await fs.writeFile(join(transmissionTorrentsDir, "valid.torrent"), torrentBuf);

    const synced = await syncFromTransmissionTorrentsDir(transmissionTorrentsDir, registryDir);
    assert.equal(synced, 1);
    assert.equal((await listRegistry(registryDir)).length, 1);
  } finally {
    await fs.rm(transmissionTorrentsDir, { recursive: true, force: true });
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test("syncFromTransmissionTorrentsDir: a missing/unreadable directory returns 0 rather than throwing", async () => {
  const { registryDir } = await scratchDirs();
  try {
    const synced = await syncFromTransmissionTorrentsDir("/nonexistent/definitely-not-real", registryDir);
    assert.equal(synced, 0);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test("syncFromTransmissionTorrentsDir: two distinct torrents both get registered, counted correctly", async () => {
  const { transmissionTorrentsDir, registryDir } = await scratchDirs();
  try {
    await fs.writeFile(join(transmissionTorrentsDir, "a.torrent"), buildSingleFileTorrent("Race A", 1));
    await fs.writeFile(join(transmissionTorrentsDir, "b.torrent"), buildSingleFileTorrent("Race B", 2));

    const synced = await syncFromTransmissionTorrentsDir(transmissionTorrentsDir, registryDir);
    assert.equal(synced, 2);
    assert.equal((await listRegistry(registryDir)).length, 2);
  } finally {
    await fs.rm(transmissionTorrentsDir, { recursive: true, force: true });
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});
