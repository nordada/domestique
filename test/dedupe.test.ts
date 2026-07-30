import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDedupe } from "../src/dedupe.js";
import { DEFAULT_RESEED_STAGING_SUBDIR } from "../src/reseed.js";

async function makeLibrary(): Promise<{ libraryRoot: string; stagingRoot: string; downloadsRoot: string; overridesPath: string }> {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-dedupe-library-"));
  const stagingRoot = join(libraryRoot, DEFAULT_RESEED_STAGING_SUBDIR);
  const downloadsRoot = await mkdtemp(join(tmpdir(), "domestique-dedupe-downloads-"));
  // Lives in downloadsRoot, not libraryRoot - commitDedupe's own buildSizeIndex
  // call only ever walks libraryRoot, so this stray JSON file can't turn up
  // as a spurious same-size candidate for anything.
  const overridesPath = join(downloadsRoot, "match-overrides.json");
  return { libraryRoot, stagingRoot, downloadsRoot, overridesPath };
}

/** Scriptable fake Transmission RPC server, same shape as transmission.test.ts's startFakeTransmissionRpc. */
function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-dedupe";
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

test("commitDedupe hardlinks the matched library file, repoints Transmission there, and reports success on a clean verify", async () => {
  const { libraryRoot, stagingRoot, downloadsRoot, overridesPath } = await makeLibrary();
  try {
    const libraryFile = join(libraryRoot, "Milan-San Remo - S2026E01.mp4");
    await writeFile(libraryFile, Buffer.alloc(1000));
    await writeFile(join(downloadsRoot, "Milan-San-Remo-2026-SBS.mp4"), Buffer.alloc(1000));

    const calls: Array<{ method: string; args?: Record<string, unknown> }> = [];
    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      calls.push({ method, args });
      if (method === "torrent-get") {
        if (args?.ids === undefined) {
          return {
            torrents: [
              {
                id: 9,
                name: "Milan-San-Remo-2026-SBS.mp4",
                hashString: "hash9",
                status: 6,
                percentDone: 1,
                downloadDir: downloadsRoot,
                files: [{ name: "Milan-San-Remo-2026-SBS.mp4", length: 1000, bytesCompleted: 1000 }],
              },
            ],
          };
        }
        return { torrents: [{ id: 9, status: 6, error: 0, errorString: "", percentDone: 1 }] };
      }
      return {};
    });
    try {
      const result = await commitDedupe(9, libraryRoot, stagingRoot, { url }, overridesPath);
      assert.equal(result.staged, true);
      assert.equal(result.reverted, false);
      assert.deepEqual(result.originalLocation, { dir: downloadsRoot, name: "Milan-San-Remo-2026-SBS.mp4" });
      assert.equal(result.verify?.percentDone, 1);

      const setLocationCalls = calls.filter((c) => c.method === "torrent-set-location");
      assert.equal(setLocationCalls.length, 1);
      assert.equal(setLocationCalls[0].args?.location, result.perTorrentDir);
      assert.equal(setLocationCalls[0].args?.move, false);
      assert.equal(calls.filter((c) => c.method === "torrent-verify").length, 1);

      const stagedPath = join(result.perTorrentDir, "Milan-San-Remo-2026-SBS.mp4");
      const [stagedStat, libraryStat] = await Promise.all([stat(stagedPath), stat(libraryFile)]);
      assert.equal(stagedStat.ino, libraryStat.ino);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("commitDedupe carries along DVD navigation files reseedMatch.ts excludes from the plan, so Transmission's verify finds the complete file set", async () => {
  // Real incident: a torrent with real content fully matched (VIDEO_TS's
  // VTS_NN_MM.VOB) alongside excluded DVD-nav files (VIDEO_TS.BUP here)
  // passed the full-match gate (correctly - see reseedMatch.ts's
  // isDvdNavigationFile exclusion) but then failed verify outright, because
  // the staging dir had the real video staged but was simply missing the
  // nav file Transmission's torrent still declares and checks on verify.
  const { libraryRoot, stagingRoot, downloadsRoot, overridesPath } = await makeLibrary();
  try {
    const libraryFile = join(libraryRoot, "Giro D'Italia - S1985E01 - pt01.vob");
    await writeFile(libraryFile, Buffer.alloc(1000));

    const torrentFolder = join(downloadsRoot, "1985 Giro d'Italia", "VIDEO_TS");
    await mkdir(torrentFolder, { recursive: true });
    await writeFile(join(torrentFolder, "VTS_01_1.VOB"), Buffer.alloc(1000));
    const navContent = Buffer.from("dvd navigation metadata, not real video");
    await writeFile(join(torrentFolder, "VIDEO_TS.BUP"), navContent);

    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      if (method === "torrent-get") {
        if (args?.ids === undefined) {
          return {
            torrents: [
              {
                id: 11,
                name: "1985 Giro d'Italia",
                hashString: "hash11",
                status: 6,
                percentDone: 1,
                downloadDir: downloadsRoot,
                files: [
                  { name: "1985 Giro d'Italia/VIDEO_TS/VTS_01_1.VOB", length: 1000, bytesCompleted: 1000 },
                  { name: "1985 Giro d'Italia/VIDEO_TS/VIDEO_TS.BUP", length: navContent.length, bytesCompleted: navContent.length },
                ],
              },
            ],
          };
        }
        return { torrents: [{ id: 11, status: 6, error: 0, errorString: "", percentDone: 1 }] };
      }
      return {};
    });
    try {
      const result = await commitDedupe(11, libraryRoot, stagingRoot, { url }, overridesPath);
      assert.equal(result.staged, true);
      assert.equal(result.reverted, false);
      assert.equal(result.plan.files.length, 1, "the nav file never appears in the plan at all");

      const stagedVob = join(result.perTorrentDir, "1985 Giro d'Italia/VIDEO_TS/VTS_01_1.VOB");
      const [stagedStat, libraryStat] = await Promise.all([stat(stagedVob), stat(libraryFile)]);
      assert.equal(stagedStat.ino, libraryStat.ino);

      const stagedNav = join(result.perTorrentDir, "1985 Giro d'Italia/VIDEO_TS/VIDEO_TS.BUP");
      const copiedContent = await readFile(stagedNav);
      assert.deepEqual(copiedContent, navContent);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("commitDedupe refuses a torrent that isn't a full, unambiguous match - no filesystem or Transmission side effects at all", async () => {
  const { libraryRoot, stagingRoot, downloadsRoot, overridesPath } = await makeLibrary();
  try {
    // Nothing in the library matches this size - unmatched, not a full match.
    const calls: string[] = [];
    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      calls.push(method);
      if (method === "torrent-get" && args?.ids === undefined) {
        return {
          torrents: [
            {
              id: 3,
              name: "Nothing-Like-This.mp4",
              hashString: "hash3",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              files: [{ name: "Nothing-Like-This.mp4", length: 999999, bytesCompleted: 999999 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await commitDedupe(3, libraryRoot, stagingRoot, { url }, overridesPath);
      assert.equal(result.staged, false);
      assert.equal(result.reverted, false);
      assert.equal(result.refusedReason, "no-full-match");
      assert.equal(result.plan.matchedCount, 0);

      // Only the initial torrent-get - never touched location/verify/staging.
      assert.deepEqual(calls, ["torrent-get"]);
      await assert.rejects(() => stat(stagingRoot));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("commitDedupe refuses a torrent that isn't fully downloaded yet, even though it's a full library match - no filesystem or Transmission side effects, never abandons a still-downloading torrent's real progress for the library's already-complete copy", async () => {
  const { libraryRoot, stagingRoot, downloadsRoot, overridesPath } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Partial - S2026E01.mp4"), Buffer.alloc(1000));

    const calls: string[] = [];
    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      calls.push(method);
      if (method === "torrent-get" && args?.ids === undefined) {
        return {
          torrents: [
            {
              id: 5,
              name: "Partial-2026.mp4",
              hashString: "hash5",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsRoot,
              // Fully matches the library by declared size, but only 420 of
              // the real 1000 bytes are actually on disk - not done yet.
              files: [{ name: "Partial-2026.mp4", length: 1000, bytesCompleted: 420 }],
            },
          ],
        };
      }
      return {};
    });
    try {
      const result = await commitDedupe(5, libraryRoot, stagingRoot, { url }, overridesPath);
      assert.equal(result.staged, false);
      assert.equal(result.reverted, false);
      assert.equal(result.refusedReason, "incomplete");
      assert.equal(result.plan.matchedCount, 1); // it IS a real library match - that's not why this refused

      // Only the initial torrent-get - never touched location/verify/staging.
      assert.deepEqual(calls, ["torrent-get"]);
      await assert.rejects(() => stat(stagingRoot));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});

test("commitDedupe automatically reverts to the original location when the post-relocate verify isn't clean", async () => {
  const { libraryRoot, stagingRoot, downloadsRoot, overridesPath } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"), Buffer.alloc(500));
    await writeFile(join(downloadsRoot, "Paris-Roubaix-2026.mp4"), Buffer.alloc(500));

    const setLocationCalls: unknown[] = [];
    let idsGetCalls = 0;
    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      if (method === "torrent-set-location") setLocationCalls.push(args);
      if (method === "torrent-get") {
        if (args?.ids === undefined) {
          return {
            torrents: [
              {
                id: 4,
                name: "Paris-Roubaix-2026.mp4",
                hashString: "hash4",
                status: 6,
                percentDone: 1,
                downloadDir: downloadsRoot,
                files: [{ name: "Paris-Roubaix-2026.mp4", length: 500, bytesCompleted: 500 }],
              },
            ],
          };
        }
        idsGetCalls += 1;
        // First poll (right after relocating to staging): a dirty/partial verify.
        // Second poll (after the automatic revert): clean, confirming the original is still good.
        return idsGetCalls === 1
          ? { torrents: [{ id: 4, status: 6, error: 1, errorString: "local error", percentDone: 0.4 }] }
          : { torrents: [{ id: 4, status: 6, error: 0, errorString: "", percentDone: 1 }] };
      }
      return {};
    });
    try {
      const result = await commitDedupe(4, libraryRoot, stagingRoot, { url }, overridesPath);
      assert.equal(result.staged, false);
      assert.equal(result.reverted, true);
      // The verify reported back is the DIRTY one from right after relocating, not the post-revert confirmation.
      assert.equal(result.verify?.error, 1);
      assert.equal(result.verify?.percentDone, 0.4);

      assert.equal(setLocationCalls.length, 2);
      assert.equal((setLocationCalls[0] as Record<string, unknown>).location, result.perTorrentDir);
      assert.equal((setLocationCalls[1] as Record<string, unknown>).location, downloadsRoot);

      // Real incident this closes: a reverted dedupe used to leave its
      // staged hardlink behind indefinitely, which could turn into a stuck
      // .fuse_hidden* file (if Transmission hadn't fully released it yet)
      // and permanently block every future dedupe attempt on that same
      // torrent. A revert must clean up after itself.
      await assert.rejects(() => stat(result.perTorrentDir));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadsRoot, { recursive: true, force: true });
  }
});
