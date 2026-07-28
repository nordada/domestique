import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewReseed, commitReseed, DEFAULT_RESEED_STAGING_SUBDIR } from "../src/reseed.js";
import { buildSingleFileTorrent, buildMultiFileTorrent } from "./torrentFixtures.js";

async function makeLibrary(): Promise<{ libraryRoot: string; stagingRoot: string }> {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-reseed-library-"));
  const stagingRoot = join(libraryRoot, DEFAULT_RESEED_STAGING_SUBDIR);
  return { libraryRoot, stagingRoot };
}

/** Scriptable fake Transmission RPC server, same shape as transmission.test.ts's startFakeTransmissionRpc. */
function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-reseed";
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

test("previewReseed matches a torrent's expected file against a same-size library file under a different name", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"), Buffer.alloc(1000));
    const torrentBuf = buildSingleFileTorrent("Paris-Roubaix-2026-SBS.mp4", 1000);

    const plan = await previewReseed(torrentBuf, libraryRoot, stagingRoot);
    assert.equal(plan.matchedCount, 1);
    assert.equal(plan.files[0].candidate, join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"));
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("previewReseed excludes the staging directory from its own candidate search", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await mkdir(join(stagingRoot, "Old Torrent"), { recursive: true });
    await writeFile(join(stagingRoot, "Old Torrent", "leftover.mp4"), Buffer.alloc(500));
    const torrentBuf = buildSingleFileTorrent("Something.mp4", 500);

    const plan = await previewReseed(torrentBuf, libraryRoot, stagingRoot);
    assert.equal(plan.matchedCount, 0);
    assert.equal(plan.unmatchedCount, 1);
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("commitReseed never touches the filesystem or Transmission when nothing matched", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    const torrentBuf = buildSingleFileTorrent("Nothing-Like-This-Exists.mp4", 123456789);
    // An unreachable URL - if commitReseed ever tried to call Transmission, this would throw/hang.
    const result = await commitReseed(torrentBuf, libraryRoot, stagingRoot, { url: "http://127.0.0.1:1" });
    assert.equal(result.staged, false);
    assert.equal(result.transmission, undefined);
    await assert.rejects(() => stat(stagingRoot));
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("commitReseed stages matched files, hands Transmission the original torrent bytes with download-dir/paused, and reports its verify result", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));
    await writeFile(join(libraryRoot, "Stage 2 renamed.mp4"), Buffer.alloc(200));
    const torrentBuf = buildMultiFileTorrent("Tour de France 2026", [
      { path: ["Stage 1.mp4"], length: 100 },
      { path: ["Stage 2.mp4"], length: 200 },
    ]);

    let receivedMetainfo: unknown;
    let receivedArgs: Record<string, unknown> | undefined;
    let startedArgs: Record<string, unknown> | undefined;
    const { url, close } = await startFakeTransmissionRpc((method, args) => {
      if (method === "torrent-add") {
        receivedMetainfo = args?.metainfo;
        receivedArgs = args;
        return { "torrent-added": { id: 42, name: "Tour de France 2026", hashString: "deadbeef" } };
      }
      if (method === "torrent-get") {
        return { torrents: [{ id: 42, status: 6, error: 0, errorString: "", percentDone: 1 }] };
      }
      if (method === "torrent-start") {
        startedArgs = args;
        return {};
      }
      return {};
    });

    try {
      const result = await commitReseed(torrentBuf, libraryRoot, stagingRoot, { url });
      assert.equal(result.staged, true);
      assert.equal(result.stagedFiles.length, 2);
      assert.equal(receivedMetainfo, torrentBuf.toString("base64"));
      assert.equal(receivedArgs?.["download-dir"], join(stagingRoot, "Tour de France 2026"));
      assert.equal(receivedArgs?.paused, true);
      assert.equal(result.transmission?.added.id, 42);
      assert.equal(result.transmission?.verify?.percentDone, 1);
      assert.equal(result.transmission?.started, true);
      assert.deepEqual(startedArgs, { ids: [42] });

      const staged1 = await readFile(join(stagingRoot, "Tour de France 2026", "Tour de France 2026", "Stage 1.mp4"));
      assert.equal(staged1.length, 100);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("commitReseed stages only the matched files of a partially-matched torrent, leaving unmatched/ambiguous entries unstaged", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));
    // Two same-size files for the "ambiguous" stage2 slot - never guessed.
    await writeFile(join(libraryRoot, "dup-a.mp4"), Buffer.alloc(200));
    await writeFile(join(libraryRoot, "dup-b.mp4"), Buffer.alloc(200));
    const torrentBuf = buildMultiFileTorrent("Partial Race", [
      { path: ["Stage 1.mp4"], length: 100 },
      { path: ["Stage 2.mp4"], length: 200 },
      { path: ["Stage 3.mp4"], length: 999999 }, // unmatched
    ]);

    let torrentStartCalled = false;
    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-add") return { "torrent-added": { id: 1, name: "Partial Race", hashString: "x" } };
      if (method === "torrent-get") return { torrents: [{ id: 1, status: 6, error: 0, errorString: "", percentDone: 0.33 }] };
      if (method === "torrent-start") torrentStartCalled = true;
      return {};
    });

    try {
      const result = await commitReseed(torrentBuf, libraryRoot, stagingRoot, { url });
      assert.equal(result.matchedCount, 1);
      assert.equal(result.ambiguousCount, 1);
      assert.equal(result.unmatchedCount, 1);
      assert.equal(result.stagedFiles.length, 1);
      assert.equal(result.transmission?.started, false);
      assert.equal(torrentStartCalled, false, "a partial verify must never be auto-started");
      await assert.rejects(() => stat(join(stagingRoot, "Partial Race", "Partial Race", "Stage 2.mp4")));
      await assert.rejects(() => stat(join(stagingRoot, "Partial Race", "Partial Race", "Stage 3.mp4")));
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("commitReseed leaves a torrent paused (started:false) when Transmission reports an error after verifying, even at 100%", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));
    const torrentBuf = buildSingleFileTorrent("Errored Race.mp4", 100);

    let torrentStartCalled = false;
    const { url, close } = await startFakeTransmissionRpc((method) => {
      if (method === "torrent-add") return { "torrent-added": { id: 5, name: "Errored Race.mp4", hashString: "y" } };
      if (method === "torrent-get") {
        return { torrents: [{ id: 5, status: 6, error: 1, errorString: "tracker error", percentDone: 1 }] };
      }
      if (method === "torrent-start") torrentStartCalled = true;
      return {};
    });

    try {
      const result = await commitReseed(torrentBuf, libraryRoot, stagingRoot, { url });
      assert.equal(result.transmission?.started, false);
      assert.equal(torrentStartCalled, false);
    } finally {
      await close();
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("commitReseed still reports staged:true with started:false if Transmission accepts the verify but the start call itself fails", async () => {
  const { libraryRoot, stagingRoot } = await makeLibrary();
  try {
    await writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));
    const torrentBuf = buildSingleFileTorrent("Flaky Race.mp4", 100);

    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { method } = JSON.parse(body) as { method: string };
        if (method === "torrent-start") {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        let args: Record<string, unknown> = {};
        if (method === "torrent-add") args = { "torrent-added": { id: 9, name: "Flaky Race.mp4", hashString: "z" } };
        if (method === "torrent-get") args = { torrents: [{ id: 9, status: 6, error: 0, errorString: "", percentDone: 1 }] };
        res.end(JSON.stringify({ result: "success", arguments: args }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/transmission/rpc`;

    try {
      const result = await commitReseed(torrentBuf, libraryRoot, stagingRoot, { url });
      assert.equal(result.staged, true);
      assert.equal(result.transmission?.verify?.percentDone, 1);
      assert.equal(result.transmission?.started, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
