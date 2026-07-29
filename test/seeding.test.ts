import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, link, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSeedingTorrents } from "../src/seeding.js";

async function makeLibrary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "domestique-seeding-library-"));
}

function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-seeding";
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

test("listSeedingTorrents includes seeding (6) and paused/stopped (0) torrents, matched against the library by size", async () => {
  const libraryRoot = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"), Buffer.alloc(1000));

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 1,
              name: "Paris-Roubaix-2026-SBS.mp4",
              status: 6,
              percentDone: 1,
              uploadRatio: 2.5,
              files: [{ name: "Paris-Roubaix-2026-SBS.mp4", length: 1000, bytesCompleted: 1000 }],
            },
            {
              id: 2,
              name: "Some Other Race",
              status: 0,
              percentDone: 1,
              files: [{ name: "Some Other Race/stage1.mp4", length: 9999, bytesCompleted: 9999 }],
            },
          ],
        };
      }
      return {};
    });

    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.equal(result.length, 2);
      const matched = result.find((t) => t.id === 1);
      assert.equal(matched?.plan.matchedCount, 1);
      assert.equal(matched?.plan.files[0].candidate, join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"));
      assert.equal(matched?.ratio, 2.5);
      const unmatched = result.find((t) => t.id === 2);
      assert.equal(unmatched?.plan.unmatchedCount, 1);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents computes percentComplete from actual file bytes, not Transmission's own percentDone - the fix for a torrent with deselected files reporting 100% despite having nothing on disk", async () => {
  const libraryRoot = await makeLibrary();
  try {
    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              // Transmission's own percentDone only counts "wanted" files,
              // so a torrent with every file deselected can legitimately
              // report 100% done while bytesCompleted is 0 for all of them.
              id: 1,
              name: "All Deselected",
              status: 0,
              percentDone: 1,
              files: [{ name: "All Deselected/stage1.mp4", length: 1000, bytesCompleted: 0 }],
            },
            {
              id: 2,
              name: "Half Done",
              status: 0,
              percentDone: 1,
              files: [
                { name: "Half Done/a.mp4", length: 1000, bytesCompleted: 1000 },
                { name: "Half Done/b.mp4", length: 1000, bytesCompleted: 0 },
              ],
            },
            {
              id: 3,
              name: "Genuinely Complete",
              status: 6,
              percentDone: 1,
              files: [{ name: "Genuinely Complete/stage1.mp4", length: 1000, bytesCompleted: 1000 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.equal(result.find((t) => t.id === 1)?.percentComplete, 0);
      assert.equal(result.find((t) => t.id === 1)?.percentDone, 1);
      assert.equal(result.find((t) => t.id === 2)?.percentComplete, 0.5);
      assert.equal(result.find((t) => t.id === 3)?.percentComplete, 1);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents excludes torrents that are downloading/checking/queued, not just seeding/paused", async () => {
  const libraryRoot = await makeLibrary();
  try {
    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            { id: 1, name: "Downloading", status: 4, percentDone: 0.5, files: [] },
            { id: 2, name: "Checking", status: 2, percentDone: 0, files: [] },
          ],
        };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.deepEqual(result, []);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents never walks the library at all when nothing is seeding/paused", async () => {
  const libraryRoot = await makeLibrary();
  try {
    let torrentGetCalls = 0;
    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        torrentGetCalls++;
        return { torrents: [] };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.deepEqual(result, []);
      assert.equal(torrentGetCalls, 1);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents computes storageStatus by comparing device+inode, not just size, between the on-disk file and its matched library candidate", async () => {
  const libraryRoot = await makeLibrary();
  const downloadsRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-downloads-"));
  try {
    // "deduped": the on-disk file is a real hardlink to the library file -
    // same inode, zero extra disk.
    const dedupedLibraryFile = join(libraryRoot, "Deduped - S2026E01.mp4");
    await writeFile(dedupedLibraryFile, Buffer.alloc(1000));
    await link(dedupedLibraryFile, join(downloadsRoot, "Deduped.mp4"));

    // "duplicate": same size, but a genuinely separate file (different inode).
    await writeFile(join(libraryRoot, "Duplicate - S2026E01.mp4"), Buffer.alloc(2000));
    await writeFile(join(downloadsRoot, "Duplicate.mp4"), Buffer.alloc(2000));

    // "mixed": a two-file torrent where one file is hardlinked and the other is a plain duplicate.
    const mixedLibraryA = join(libraryRoot, "Mixed A - S2026E01.mp4");
    const mixedLibraryB = join(libraryRoot, "Mixed B - S2026E01.mp4");
    await writeFile(mixedLibraryA, Buffer.alloc(3000));
    await writeFile(mixedLibraryB, Buffer.alloc(4000));
    await mkdir(join(downloadsRoot, "Mixed Torrent"), { recursive: true });
    await link(mixedLibraryA, join(downloadsRoot, "Mixed Torrent", "a.mp4"));
    await writeFile(join(downloadsRoot, "Mixed Torrent", "b.mp4"), Buffer.alloc(4000));

    // "n/a": nothing in the library matches this size at all - not a full match, no meaningful comparison.
    await writeFile(join(downloadsRoot, "Unmatched.mp4"), Buffer.alloc(5000));

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 1,
              name: "Deduped.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              files: [{ name: "Deduped.mp4", length: 1000, bytesCompleted: 1000 }],
            },
            {
              id: 2,
              name: "Duplicate.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              files: [{ name: "Duplicate.mp4", length: 2000, bytesCompleted: 2000 }],
            },
            {
              id: 3,
              name: "Mixed Torrent",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              files: [
                { name: "Mixed Torrent/a.mp4", length: 3000, bytesCompleted: 3000 },
                { name: "Mixed Torrent/b.mp4", length: 4000, bytesCompleted: 4000 },
              ],
            },
            {
              id: 4,
              name: "Unmatched.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              files: [{ name: "Unmatched.mp4", length: 5000, bytesCompleted: 5000 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.equal(result.find((t) => t.id === 1)?.storageStatus, "deduped");
      assert.equal(result.find((t) => t.id === 2)?.storageStatus, "duplicate");
      assert.equal(result.find((t) => t.id === 3)?.storageStatus, "mixed");
      assert.equal(result.find((t) => t.id === 4)?.storageStatus, "n/a");
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents flags orphanOriginal only when a deduped torrent's original download-folder copy is confirmed still present at its exact expected size", async () => {
  const libraryRoot = await makeLibrary();
  const activeRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-active-"));
  const downloadsRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-downloads-"));
  try {
    // Torrent 1: deduped, AND its original is still sitting at the exact
    // downloads-path location with the exact expected size - should be flagged.
    const lib1 = join(libraryRoot, "Orphan Present - S2026E01.mp4");
    await writeFile(lib1, Buffer.alloc(2000));
    await link(lib1, join(activeRoot, "Orphan-Present.mp4"));
    await writeFile(join(downloadsRoot, "Orphan-Present.mp4"), Buffer.alloc(2000));

    // Torrent 2: deduped, but its original was already deleted - nothing at
    // that path at all. Should NOT be flagged.
    const lib2 = join(libraryRoot, "Already Cleaned - S2026E01.mp4");
    await writeFile(lib2, Buffer.alloc(1500));
    await link(lib2, join(activeRoot, "Already-Cleaned.mp4"));
    // (deliberately nothing written at downloadsRoot/Already-Cleaned.mp4)

    // Torrent 3: deduped, but the file sitting at the original path is a
    // different size (already edited/replaced by something else) - a
    // partial/ambiguous leftover, deliberately NOT flagged rather than guessed at.
    const lib3 = join(libraryRoot, "Resized Leftover - S2026E01.mp4");
    await writeFile(lib3, Buffer.alloc(3000));
    await link(lib3, join(activeRoot, "Resized-Leftover.mp4"));
    await writeFile(join(downloadsRoot, "Resized-Leftover.mp4"), Buffer.alloc(999));

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 1,
              name: "Orphan-Present.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: activeRoot,
              files: [{ name: "Orphan-Present.mp4", length: 2000, bytesCompleted: 2000 }],
            },
            {
              id: 2,
              name: "Already-Cleaned.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: activeRoot,
              files: [{ name: "Already-Cleaned.mp4", length: 1500, bytesCompleted: 1500 }],
            },
            {
              id: 3,
              name: "Resized-Leftover.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: activeRoot,
              files: [{ name: "Resized-Leftover.mp4", length: 3000, bytesCompleted: 3000 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), downloadsRoot);

      const t1 = result.find((t) => t.id === 1);
      assert.equal(t1?.storageStatus, "deduped");
      assert.deepEqual(t1?.orphanOriginal, { dir: downloadsRoot, name: "Orphan-Present.mp4", totalBytes: 2000 });

      const t2 = result.find((t) => t.id === 2);
      assert.equal(t2?.storageStatus, "deduped");
      assert.equal(t2?.orphanOriginal, null);

      const t3 = result.find((t) => t.id === 3);
      assert.equal(t3?.storageStatus, "deduped");
      assert.equal(t3?.orphanOriginal, null);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(activeRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("listSeedingTorrents correctly resolves a torrent reseeded via this app back to its ORIGINAL library file, not its own staged copy", async () => {
  const libraryRoot = await makeLibrary();
  try {
    // Simulates the outcome of a real Reseed commit: the original library
    // file stays put, and a hardlinked copy also exists under the (excluded)
    // staging directory - listSeedingTorrents must still resolve to the
    // original, not fail to match just because the staged copy is excluded.
    await writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));

    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-get") {
        return {
          torrents: [
            {
              id: 1,
              name: "Tour de France 2026",
              status: 6,
              percentDone: 1,
              files: [{ name: "Tour de France 2026/Stage 1.mp4", length: 100, bytesCompleted: 100 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"), "/nonexistent");
      assert.equal(result[0].plan.matchedCount, 1);
      assert.equal(result[0].plan.files[0].candidate, join(libraryRoot, "Stage 1 renamed.mp4"));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
