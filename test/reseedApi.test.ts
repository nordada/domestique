import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createApp, type ServerOptions } from "../src/server.js";
import { buildSingleFileTorrent, buildMultiFileTorrent } from "./torrentFixtures.js";
import { getDedupeOriginal, recordDedupeOriginal } from "../src/dedupeState.js";
import { registerTorrent, listRegistry } from "../src/torrentRegistry.js";

async function makeScratchServer(downloadsPath?: string) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-library-"));
  const configPath = join(configDir, "events.json");
  const settingsPath = join(configDir, "settings.json");
  const activityPath = join(configDir, "activity.json");
  const dedupeStatePath = join(configDir, "dedupe-state.json");
  const torrentRegistryDir = join(configDir, "torrent-registry");
  await fs.writeFile(configPath, JSON.stringify({ shows: [] }) + "\n", "utf-8");
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    activityPath,
    downloadsPath: downloadsPath ?? "/nonexistent",
    dedupeStatePath,
    torrentRegistryDir,
    webui: { password: "correct-password" },
  };

  const server = createApp(opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    libraryRoot,
    settingsPath,
    activityPath,
    dedupeStatePath,
    torrentRegistryDir,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authHeader(): string {
  return `Basic ${Buffer.from("anything:correct-password").toString("base64")}`;
}

function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-reseedapi";
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
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

test("POST /api/reseed/preview reports a matched file without touching the filesystem or Transmission", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer();
  try {
    await fs.writeFile(join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"), Buffer.alloc(1000));
    const torrentBuf = buildSingleFileTorrent("Paris-Roubaix-2026-SBS.mp4", 1000);

    const res = await fetch(`${baseUrl}/api/reseed/preview`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.plan.matchedCount, 1);
    assert.equal(body.plan.files[0].status, "matched");

    // Preview must never create the staging directory.
    await assert.rejects(() => fs.stat(join(libraryRoot, ".reseed-staging")));
  } finally {
    await close();
  }
});

test("POST /api/reseed/preview rejects an invalid .torrent with a 400, not a 500", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/preview`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: Buffer.from("not a torrent"),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/reseed/commit without Transmission configured logs to activity and returns 400", async () => {
  const { baseUrl, activityPath, close } = await makeScratchServer();
  try {
    const torrentBuf = buildSingleFileTorrent("Something.mp4", 12345);
    const res = await fetch(`${baseUrl}/api/reseed/commit`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /isn't configured/i);

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.equal(activity[0].reviewWorthy, true);
    assert.match(activity[0].lines[0], /isn't configured/);
  } finally {
    await close();
  }
});

test("POST /api/reseed/commit stages a matched file, adds it to Transmission, and logs a clean activity entry on a full verify", async () => {
  const { baseUrl, libraryRoot, settingsPath, activityPath, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-add") {
      return { "torrent-added": { id: 7, name: "Tour de France 2026", hashString: "abc" } };
    }
    if (method === "torrent-get") {
      return { torrents: [{ id: 7, status: 6, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    await fs.writeFile(join(libraryRoot, "Stage 1 renamed.mp4"), Buffer.alloc(100));

    const torrentBuf = buildMultiFileTorrent("Tour de France 2026", [{ path: ["Stage 1.mp4"], length: 100 }]);
    const res = await fetch(`${baseUrl}/api/reseed/commit`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.staged, true);
    assert.equal(body.result.transmission.verify.percentDone, 1);
    assert.equal(body.result.transmission.started, true);

    const staged = await fs.readFile(
      join(libraryRoot, ".reseed-staging", "Tour de France 2026", "Tour de France 2026", "Stage 1.mp4")
    );
    assert.equal(staged.length, 100);

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.equal(activity[0].reviewWorthy, false);
    assert.match(activity[0].lines.join("\n"), /staged 1\/1 file/);
    assert.match(activity[0].lines.join("\n"), /verified 100%.*started seeding/);
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/commit reports staged:false without touching Transmission when nothing in the library matches", async () => {
  const { baseUrl, libraryRoot, settingsPath, close: closeApp } = await makeScratchServer();
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      // Unreachable - if commit ever tried to call Transmission here, the request would fail/hang.
      JSON.stringify({ ...current, transmission: { url: "http://127.0.0.1:1/transmission/rpc" } }) + "\n",
      "utf-8"
    );

    const torrentBuf = buildSingleFileTorrent("Nothing-Like-This.mp4", 999999999);
    const res = await fetch(`${baseUrl}/api/reseed/commit`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.staged, false);
    await assert.rejects(() => fs.stat(join(libraryRoot, ".reseed-staging")));
  } finally {
    await closeApp();
  }
});

test("GET /api/reseed/seeding without Transmission configured returns 400, no library walk needed", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/seeding`, { headers: { Authorization: authHeader() } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /isn't configured/i);
  } finally {
    await close();
  }
});

test("GET /api/reseed/seeding returns seeding/paused torrents matched against the library", async () => {
  const { baseUrl, libraryRoot, settingsPath, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
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
          { id: 2, name: "Still Downloading", status: 4, percentDone: 0.2, files: [] },
        ],
      };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    await fs.writeFile(join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"), Buffer.alloc(1000));

    const res = await fetch(`${baseUrl}/api/reseed/seeding`, { headers: { Authorization: authHeader() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.torrents.length, 1);
    assert.equal(body.torrents[0].id, 1);
    assert.equal(body.torrents[0].plan.matchedCount, 1);
    assert.equal(body.torrents[0].plan.files[0].candidate, join(libraryRoot, "Paris-Roubaix - S2026E01.mp4"));
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/add-to-library without Transmission configured returns 400", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /isn't configured/i);
  } finally {
    await close();
  }
});

test("POST /api/reseed/add-to-library rejects a body without a numeric id", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /numeric id/i);
  } finally {
    await close();
  }
});

test("POST /api/reseed/add-to-library returns 404 when Transmission doesn't report that torrent id", async () => {
  const { baseUrl, settingsPath, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) =>
    method === "torrent-get" ? { torrents: [] } : {}
  );
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 99 }),
    });
    assert.equal(res.status, 404);
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/add-to-library refuses a torrent whose reported location resolves outside the downloads share", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const outsideDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-outside-"));
  const { baseUrl, libraryRoot, settingsPath, close: closeApp } = await makeScratchServer(downloadsDir);
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return { torrents: [{ id: 5, name: "sneaky.mp4", downloadDir: outsideDir }] };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 5 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /outside the downloads share/);
    // Confirm nothing was copied - the library should still be empty.
    assert.deepEqual(await fs.readdir(libraryRoot), []);
  } finally {
    await closeApp();
    await closeTransmission();
    await fs.rm(downloadsDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/add-to-library runs a real seeding torrent through the normal ingestion pipeline", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const { baseUrl, libraryRoot, settingsPath, activityPath, close: closeApp } = await makeScratchServer(downloadsDir);
  await fs.writeFile(join(downloadsDir, "Tour-de-France-2026-Stage-18-SBS.mp4"), Buffer.alloc(1000));

  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return {
        torrents: [{ id: 3, name: "Tour-de-France-2026-Stage-18-SBS.mp4", downloadDir: downloadsDir }],
      };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );

    const res = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 3 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.results[0].status, "copied");

    // handleTorrentDone auto-created a show and copied the file - same
    // pipeline the webhook uses, so its own activity entry is what's
    // recorded (this route doesn't write its own).
    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.match(activity[0].lines.join("\n"), /auto-created show/i);

    const showDirs = await fs.readdir(libraryRoot);
    assert.ok(showDirs.length > 0, "expected an auto-created show folder in the library");
  } finally {
    await closeApp();
    await closeTransmission();
    await fs.rm(downloadsDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/add-to-library with force:true bypasses a duplicate-destination skip and files a distinctly-tagged copy", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const { baseUrl, libraryRoot, settingsPath, close: closeApp } = await makeScratchServer(downloadsDir);
  await fs.writeFile(join(downloadsDir, "TDF-Stage18-SBS.mp4"), Buffer.alloc(500));

  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return { torrents: [{ id: 4, name: "TDF-Stage18-SBS.mp4", downloadDir: downloadsDir }] };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );

    const addOnce = () =>
      fetch(`${baseUrl}/api/reseed/add-to-library`, {
        method: "POST",
        headers: { Authorization: authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: 4 }),
      }).then((r) => r.json());

    const firstAttempt = await addOnce();
    assert.equal(firstAttempt.results[0].status, "copied");

    // Same identity (same show/stage, still no resolution/broadcaster
    // tag), different bytes - re-processing it again without force should
    // skip as a plain duplicate, same as any repeated webhook fire.
    await fs.writeFile(join(downloadsDir, "TDF-Stage18-SBS.mp4"), Buffer.alloc(700));
    const withoutForce = await addOnce();
    assert.equal(withoutForce.results[0].status, "skipped");
    assert.match(withoutForce.results[0].warning, /destination already exists/);

    const withForceRes = await fetch(`${baseUrl}/api/reseed/add-to-library`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 4, force: true }),
    });
    const withForce = await withForceRes.json();
    assert.equal(withForceRes.status, 200);
    assert.equal(withForce.results[0].status, "copied");
    assert.match(withForce.results[0].destPath, /REVIEW - forced/);

    // Both files now coexist in the library - the original untouched, plus
    // the forced copy alongside it.
    const seasonDir = join(libraryRoot, "Tdf", "Season 2026");
    const files = await fs.readdir(seasonDir);
    assert.equal(files.filter((f) => f.endsWith(".mp4")).length, 2);
  } finally {
    await closeApp();
    await closeTransmission();
    await fs.rm(downloadsDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/remove without Transmission configured returns 400", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/remove`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /isn't configured/i);
  } finally {
    await close();
  }
});

test("POST /api/reseed/remove rejects a body without a numeric id", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/remove`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/reseed/remove returns 404 when Transmission doesn't report that torrent id", async () => {
  const { baseUrl, settingsPath, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) =>
    method === "torrent-get" ? { torrents: [] } : {}
  );
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/remove`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 42 }),
    });
    assert.equal(res.status, 404);
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/remove calls torrent-remove with delete-local-data and logs an activity entry with the real torrent name", async () => {
  const { baseUrl, settingsPath, activityPath, close: closeApp } = await makeScratchServer();
  let receivedArgs;
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method, args) => {
    if (method === "torrent-get") return { torrents: [{ id: 8, name: "Vuelta-2026-Stage-3", downloadDir: "/downloads" }] };
    if (method === "torrent-remove") {
      receivedArgs = args;
      return {};
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/remove`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 8 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, "Vuelta-2026-Stage-3");
    assert.deepEqual(receivedArgs, { ids: [8], "delete-local-data": true });

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.equal(activity[0].torrentName, "Vuelta-2026-Stage-3");
    assert.match(activity[0].lines.join("\n"), /removed.*deleted its downloaded data/i);
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/dedupe without Transmission configured returns 400", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/dedupe`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /isn't configured/i);
  } finally {
    await close();
  }
});

test("POST /api/reseed/dedupe rejects a body without a numeric id", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/dedupe`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/reseed/dedupe hardlinks a full-duplicate torrent to the library, verifies clean, and logs success", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const { baseUrl, libraryRoot, settingsPath, activityPath, dedupeStatePath, close: closeApp } =
    await makeScratchServer(downloadsDir);
  const libraryFile = join(libraryRoot, "Il Lombardia - S2026E01.mp4");
  await fs.writeFile(libraryFile, Buffer.alloc(1000));
  await fs.writeFile(join(downloadsDir, "Il-Lombardia-2026.mp4"), Buffer.alloc(1000));
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method, args) => {
    if (method === "torrent-get") {
      if (args?.ids === undefined) {
        return {
          torrents: [
            {
              id: 6,
              name: "Il-Lombardia-2026.mp4",
              status: 6,
              percentDone: 1,
              downloadDir: downloadsDir,
              files: [{ name: "Il-Lombardia-2026.mp4", length: 1000, bytesCompleted: 1000 }],
            },
          ],
        };
      }
      return { torrents: [{ id: 6, status: 6, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/dedupe`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 6 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.staged, true);
    assert.deepEqual(body.result.originalLocation, { dir: downloadsDir, name: "Il-Lombardia-2026.mp4" });

    const stagedPath = join(body.result.perTorrentDir, "Il-Lombardia-2026.mp4");
    const [stagedStat, libraryStat] = await Promise.all([fs.stat(stagedPath), fs.stat(libraryFile)]);
    assert.equal(stagedStat.ino, libraryStat.ino);

    // The real bug this closes: without this recorded entry, a later list
    // load has no way to know where "Il-Lombardia-2026.mp4"'s data used to
    // live, since Transmission itself forgets once torrent-set-location moves it.
    assert.deepEqual(getDedupeOriginal("Il-Lombardia-2026.mp4", dedupeStatePath), {
      dir: downloadsDir,
      name: "Il-Lombardia-2026.mp4",
    });

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.equal(activity[0].reviewWorthy, false);
    assert.match(activity[0].lines.join("\n"), /deduped/i);
  } finally {
    await closeApp();
    await closeTransmission();
    await fs.rm(downloadsDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/dedupe refuses a torrent that isn't a full match, with no side effects, and logs it as review-worthy", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const { baseUrl, settingsPath, activityPath, close: closeApp } = await makeScratchServer(downloadsDir);
  await fs.writeFile(join(downloadsDir, "Nothing-Like-This.mp4"), Buffer.alloc(999999));
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method, args) => {
    if (method === "torrent-get" && args?.ids === undefined) {
      return {
        torrents: [
          {
            id: 7,
            name: "Nothing-Like-This.mp4",
            status: 6,
            percentDone: 1,
            downloadDir: downloadsDir,
            files: [{ name: "Nothing-Like-This.mp4", length: 999999, bytesCompleted: 999999 }],
          },
        ],
      };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    const res = await fetch(`${baseUrl}/api/reseed/dedupe`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: 7 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.staged, false);
    assert.equal(body.result.reverted, false);

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.equal(activity[0].reviewWorthy, true);
  } finally {
    await closeApp();
    await closeTransmission();
    await fs.rm(downloadsDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/delete-original rejects a body without dir/name", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/delete-original`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/reseed/delete-original refuses a path outside the downloads share", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const outsideDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-outside-"));
  const { baseUrl, close } = await makeScratchServer(downloadsDir);
  const outsideFile = join(outsideDir, "secret.txt");
  await fs.writeFile(outsideFile, "should never be deleted");
  try {
    const res = await fetch(`${baseUrl}/api/reseed/delete-original`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ dir: outsideDir, name: "secret.txt" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /resolve inside the downloads share/);
    assert.equal(await fs.readFile(outsideFile, "utf-8"), "should never be deleted");
  } finally {
    await close();
    await fs.rm(downloadsDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/delete-original deletes the file, logs an activity entry, and clears the recorded dedupeState entry", async () => {
  const downloadsDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-downloads-"));
  const { baseUrl, activityPath, dedupeStatePath, close } = await makeScratchServer(downloadsDir);
  const filePath = join(downloadsDir, "Il-Lombardia-2026.mp4");
  await fs.writeFile(filePath, Buffer.alloc(1000));
  // Simulates a prior successful dedupe having recorded this - the delete
  // route should clear it so a future, unrelated torrent reusing this name
  // never gets misled by a stale entry.
  recordDedupeOriginal("Il-Lombardia-2026.mp4", { dir: downloadsDir, name: "Il-Lombardia-2026.mp4" }, dedupeStatePath);
  try {
    const res = await fetch(`${baseUrl}/api/reseed/delete-original`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ dir: downloadsDir, name: "Il-Lombardia-2026.mp4" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    await assert.rejects(() => fs.stat(filePath));
    assert.equal(getDedupeOriginal("Il-Lombardia-2026.mp4", dedupeStatePath), undefined);

    const activity = JSON.parse(await fs.readFile(activityPath, "utf-8"));
    assert.match(activity[0].lines.join("\n"), /deleted the now-deduped original/i);
  } finally {
    await close();
    await fs.rm(downloadsDir, { recursive: true, force: true });
  }
});

test("POST /api/reseed/commit registers the torrent on a successful stage, but not on a no-match skip", async () => {
  const { baseUrl, libraryRoot, settingsPath, torrentRegistryDir, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-add") {
      return { "torrent-added": { id: 9, name: "Registered Race", hashString: "abc" } };
    }
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 6, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );
    await fs.writeFile(join(libraryRoot, "Registered Race - renamed.mp4"), Buffer.alloc(50));

    const matchedRes = await fetch(`${baseUrl}/api/reseed/commit`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: buildSingleFileTorrent("Registered Race", 50),
    });
    assert.equal((await matchedRes.json()).result.staged, true);

    const entries = await listRegistry(torrentRegistryDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].torrentName, "Registered Race");

    // A torrent that matches nothing must NOT be registered - a no-match
    // skip is exactly what should still be retryable later, not silently
    // treated as "already handled".
    const unmatchedRes = await fetch(`${baseUrl}/api/reseed/commit`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: buildSingleFileTorrent("Totally Unmatched", 999999999),
    });
    assert.equal((await unmatchedRes.json()).result.staged, false);

    const entriesAfter = await listRegistry(torrentRegistryDir);
    assert.equal(entriesAfter.length, 1); // still just the one from the successful stage
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("POST /api/reseed/registry/check reports alreadyRegistered accurately, before and after registration", async () => {
  const { baseUrl, torrentRegistryDir, close } = await makeScratchServer();
  try {
    const torrentBuf = buildSingleFileTorrent("Check Me", 123);

    const before = await fetch(`${baseUrl}/api/reseed/registry/check`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(before.status, 200);
    const beforeBody = await before.json();
    assert.equal(beforeBody.torrentName, "Check Me");
    assert.equal(beforeBody.alreadyRegistered, false);

    await registerTorrent("Check Me", torrentBuf, torrentRegistryDir);

    const after = await fetch(`${baseUrl}/api/reseed/registry/check`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: torrentBuf,
    });
    assert.equal(after.status, 200);
    assert.equal((await after.json()).alreadyRegistered, true);
  } finally {
    await close();
  }
});

test("POST /api/reseed/registry/check rejects an invalid .torrent with a 400", async () => {
  const { baseUrl, close } = await makeScratchServer();
  try {
    const res = await fetch(`${baseUrl}/api/reseed/registry/check`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: Buffer.from("not a torrent"),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("GET /api/reseed/registry cross-references every registered torrent against the live library and Transmission state, independently in each direction", async () => {
  const { baseUrl, libraryRoot, settingsPath, torrentRegistryDir, close: closeApp } = await makeScratchServer();
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return {
        torrents: [
          { id: 1, name: "Both", status: 6, percentDone: 1, files: [] },
          { id: 2, name: "TransmissionOnly", status: 6, percentDone: 1, files: [] },
        ],
      };
    }
    return {};
  });
  try {
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );

    // "Both" and "PlexOnly" each have a same-size library file, so both are
    // findable in Plex; "TransmissionOnly" and "Neither" deliberately don't.
    await fs.writeFile(join(libraryRoot, "Both - renamed.mp4"), Buffer.alloc(111));
    await fs.writeFile(join(libraryRoot, "PlexOnly - renamed.mp4"), Buffer.alloc(222));

    await registerTorrent("Both", buildSingleFileTorrent("Both", 111), torrentRegistryDir);
    await registerTorrent("PlexOnly", buildSingleFileTorrent("PlexOnly", 222), torrentRegistryDir);
    await registerTorrent("TransmissionOnly", buildSingleFileTorrent("TransmissionOnly", 333), torrentRegistryDir);
    await registerTorrent("Neither", buildSingleFileTorrent("Neither", 444), torrentRegistryDir);

    const res = await fetch(`${baseUrl}/api/reseed/registry`, { headers: { Authorization: authHeader() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.summary.total, 4);
    assert.equal(body.summary.inPlexCount, 2);
    assert.equal(body.summary.inTransmissionCount, 2);

    const byName = Object.fromEntries(body.torrents.map((t: { torrentName: string }) => [t.torrentName, t]));
    assert.deepEqual(
      { inPlex: byName.Both.inPlex, inTransmission: byName.Both.inTransmission },
      { inPlex: true, inTransmission: true }
    );
    assert.deepEqual(
      { inPlex: byName.PlexOnly.inPlex, inTransmission: byName.PlexOnly.inTransmission },
      { inPlex: true, inTransmission: false }
    );
    assert.deepEqual(
      { inPlex: byName.TransmissionOnly.inPlex, inTransmission: byName.TransmissionOnly.inTransmission },
      { inPlex: false, inTransmission: true }
    );
    assert.deepEqual(
      { inPlex: byName.Neither.inPlex, inTransmission: byName.Neither.inTransmission },
      { inPlex: false, inTransmission: false }
    );
  } finally {
    await closeApp();
    await closeTransmission();
  }
});

test("GET /api/reseed/registry reports every entry as not-in-Transmission (rather than failing) when Transmission isn't configured", async () => {
  const { baseUrl, torrentRegistryDir, close } = await makeScratchServer();
  try {
    await registerTorrent("No Transmission Configured", buildSingleFileTorrent("No Transmission Configured", 50), torrentRegistryDir);

    const res = await fetch(`${baseUrl}/api/reseed/registry`, { headers: { Authorization: authHeader() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary.total, 1);
    assert.equal(body.summary.inTransmissionCount, 0);
    assert.equal(body.torrents[0].inTransmission, false);
  } finally {
    await close();
  }
});

test("GET /api/reseed/registry/download serves back the exact bytes previously registered, and 404s an unknown/malformed name", async () => {
  const { baseUrl, torrentRegistryDir, close } = await makeScratchServer();
  try {
    const torrentBuf = buildSingleFileTorrent("Download Me", 999);
    await registerTorrent("Download Me", torrentBuf, torrentRegistryDir);

    const res = await fetch(`${baseUrl}/api/reseed/registry/download?name=${encodeURIComponent("Download Me")}`, {
      headers: { Authorization: authHeader() },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-bittorrent");
    const downloaded = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(downloaded, torrentBuf);

    const missing = await fetch(`${baseUrl}/api/reseed/registry/download?name=${encodeURIComponent("Never Registered")}`, {
      headers: { Authorization: authHeader() },
    });
    assert.equal(missing.status, 404);

    // Path-traversal attempt in `name` - must 404 like any other unknown
    // name, not throw or escape the registry directory.
    const traversal = await fetch(`${baseUrl}/api/reseed/registry/download?name=${encodeURIComponent("../../etc/passwd")}`, {
      headers: { Authorization: authHeader() },
    });
    assert.equal(traversal.status, 404);
  } finally {
    await close();
  }
});
