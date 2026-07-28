import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createApp, type ServerOptions } from "../src/server.js";
import { buildSingleFileTorrent, buildMultiFileTorrent } from "./torrentFixtures.js";

async function makeScratchServer() {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-reseedapi-library-"));
  const configPath = join(configDir, "events.json");
  const settingsPath = join(configDir, "settings.json");
  const activityPath = join(configDir, "activity.json");
  await fs.writeFile(configPath, JSON.stringify({ shows: [] }) + "\n", "utf-8");
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    activityPath,
    downloadsPath: "/nonexistent",
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
