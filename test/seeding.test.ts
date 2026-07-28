import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"));
      assert.equal(result.length, 2);
      const matched = result.find((t) => t.id === 1);
      assert.equal(matched?.plan.matchedCount, 1);
      assert.equal(matched?.plan.files[0].candidate, join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"));
      const unmatched = result.find((t) => t.id === 2);
      assert.equal(unmatched?.plan.unmatchedCount, 1);
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
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"));
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
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"));
      assert.deepEqual(result, []);
      assert.equal(torrentGetCalls, 1);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
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
      const result = await listSeedingTorrents({ url }, libraryRoot, join(libraryRoot, ".reseed-staging"));
      assert.equal(result[0].plan.matchedCount, 1);
      assert.equal(result[0].plan.files[0].candidate, join(libraryRoot, "Stage 1 renamed.mp4"));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
