import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTorrentIndex } from "../src/torrentIndex.js";
import { registerTorrent } from "../src/torrentRegistry.js";
import { recordVerifyResult } from "../src/verifyState.js";
import { parseTorrentFile } from "../src/torrentFile.js";
import { buildSingleFileTorrent } from "./torrentFixtures.js";

async function scratchDirs() {
  const registryDir = await fs.mkdtemp(join(tmpdir(), "domestique-torrentindex-registry-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-torrentindex-library-"));
  const stagingRoot = join(libraryRoot, ".reseed-staging");
  const downloadsPath = await fs.mkdtemp(join(tmpdir(), "domestique-torrentindex-downloads-"));
  const dedupeStatePath = join(downloadsPath, "dedupe-state.json");
  const verifyStatePath = join(downloadsPath, "verify-state.json");
  return { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath };
}

function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-torrentindex";
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.headers["x-transmission-session-id"] !== sessionId) {
        res.writeHead(409, { "X-Transmission-Session-Id": sessionId });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { method, arguments: args } = JSON.parse(body) as {
          method: string;
          arguments?: Record<string, unknown>;
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "success", arguments: handleMethod(method, args) }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/transmission/rpc`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("buildTorrentIndex: an entry found in both Plex and Transmission reports both, correlated by info-hash not name", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Both-2026-SBS.mp4", 1000);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);
    await fs.writeFile(join(libraryRoot, "Both - S2026E01.mp4"), Buffer.alloc(1000));

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 42,
              name: "Both-2026-SBS.mp4", // deliberately a DIFFERENT display name than what's registered - hash must still correlate
              status: 6,
              percentDone: 1,
              uploadRatio: 1.5,
              downloadDir: downloadsPath,
              hashString: meta.infoHash.toUpperCase(), // Transmission's own casing shouldn't matter either
              files: [{ name: "Both-2026-SBS.mp4", length: 1000, bytesCompleted: 1000 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const { entries, summary } = await buildTorrentIndex({
        registryDir,
        libraryRoot,
        stagingRoot,
        downloadsPath,
        dedupeStatePath,
        verifyStatePath,
        transmissionConfig: { url },
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].infoHash, meta.infoHash);
      assert.equal(entries[0].inPlex, true);
      assert.equal(entries[0].inTransmission, true);
      assert.equal(entries[0].transmissionId, 42);
      assert.equal(entries[0].ratio, 1.5);
      assert.equal(summary.total, 1);
      assert.equal(summary.inPlexCount, 1);
      assert.equal(summary.inTransmissionCount, 1);
      assert.equal(summary.seedingCount, 1);
    } finally {
      await close();
    }
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: an entry matched in Plex but with no live Transmission torrent reports inTransmission:false and null live fields", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("PlexOnly", 500);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);
    await fs.writeFile(join(libraryRoot, "PlexOnly - renamed.mp4"), Buffer.alloc(500));

    const { entries, summary } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      transmissionConfig: null,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].inPlex, true);
    assert.equal(entries[0].inTransmission, false);
    assert.equal(entries[0].transmissionId, null);
    assert.equal(entries[0].status, null);
    assert.equal(entries[0].ratio, null);
    assert.equal(entries[0].storageStatus, "n/a");
    assert.equal(summary.inTransmissionCount, 0);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: a live Transmission-only entry (not matched in Plex) reports inPlex:false", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("TransmissionOnly", 777);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);
    // Deliberately nothing written into libraryRoot - no Plex match possible.

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 1,
              name: "TransmissionOnly",
              status: 6,
              percentDone: 1,
              uploadRatio: 0,
              downloadDir: downloadsPath,
              hashString: meta.infoHash,
              files: [{ name: "TransmissionOnly", length: 777, bytesCompleted: 777 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const { entries, summary } = await buildTorrentIndex({
        registryDir,
        libraryRoot,
        stagingRoot,
        downloadsPath,
        dedupeStatePath,
        verifyStatePath,
        transmissionConfig: { url },
      });
      assert.equal(entries[0].inPlex, false);
      assert.equal(entries[0].inTransmission, true);
      assert.equal(summary.inPlexCount, 0);
    } finally {
      await close();
    }
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: an entry found in neither system still appears, reporting both false", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Neither", 999999);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);

    const { entries, summary } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      transmissionConfig: null,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].inPlex, false);
    assert.equal(entries[0].inTransmission, false);
    assert.equal(summary.total, 1);
    assert.equal(summary.inPlexCount, 0);
    assert.equal(summary.inTransmissionCount, 0);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: gracefully degrades (never throws) when the Transmission RPC call fails, reporting every entry as not-in-Transmission", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Unreachable", 42);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);

    const { entries } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      // Unreachable host - the RPC call should fail and be caught internally.
      transmissionConfig: { url: "http://127.0.0.1:1/transmission/rpc" },
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].inTransmission, false);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: returns an empty index when the registry is empty, without any Transmission call needed", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const { entries, summary } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      verifyStatePath,
      transmissionConfig: null,
    });
    assert.deepEqual(entries, []);
    assert.equal(summary.total, 0);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: surfaces the most recent verify result (lastVerify) on an entry, whether or not it's currently in Transmission", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Flagged-2020-Stage-09.mp4", 1000);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);
    await fs.writeFile(join(libraryRoot, "Flagged - S2020E09.mp4"), Buffer.alloc(1000));

    const record = { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 0.42, clean: false };
    recordVerifyResult(meta.infoHash, record, verifyStatePath);

    // Not currently in Transmission at all - a torrent that got removed
    // after being flagged should still show the flag, not lose it.
    const { entries } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      verifyStatePath,
      transmissionConfig: null,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].inTransmission, false);
    assert.deepEqual(entries[0].lastVerify, record);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});

test("buildTorrentIndex: an entry that's never been verified reports lastVerify: null", async () => {
  const { registryDir, libraryRoot, stagingRoot, downloadsPath, dedupeStatePath, verifyStatePath } = await scratchDirs();
  try {
    const torrentBuf = buildSingleFileTorrent("Never-Verified.mp4", 500);
    const meta = parseTorrentFile(torrentBuf);
    await registerTorrent(meta.infoHash, torrentBuf, registryDir);

    const { entries } = await buildTorrentIndex({
      registryDir,
      libraryRoot,
      stagingRoot,
      downloadsPath,
      dedupeStatePath,
      verifyStatePath,
      transmissionConfig: null,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].lastVerify, null);
  } finally {
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(libraryRoot, { recursive: true, force: true });
    await fs.rm(downloadsPath, { recursive: true, force: true });
  }
});
