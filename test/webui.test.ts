import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ServerOptions } from "../src/server.js";
import { webUiConfigFromEnv } from "../src/webui.js";

test("webUiConfigFromEnv returns null unless WEBUI_PASSWORD is set", () => {
  const saved = process.env.WEBUI_PASSWORD;
  try {
    delete process.env.WEBUI_PASSWORD;
    assert.equal(webUiConfigFromEnv(), null);

    process.env.WEBUI_PASSWORD = "hunter2";
    assert.deepEqual(webUiConfigFromEnv(), { password: "hunter2" });
  } finally {
    if (saved === undefined) delete process.env.WEBUI_PASSWORD;
    else process.env.WEBUI_PASSWORD = saved;
  }
});

async function makeScratchServer(webuiPassword: string | null) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-webui-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-webui-library-"));
  const configPath = join(configDir, "shows.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      shows: [{ id: "tdf", folderName: "Tour de France", matchKeywords: ["tour de france", "tdf"], type: "stage-race" }],
    }) + "\n",
    "utf-8"
  );

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    plex: null,
    discord: null,
    webui: webuiPassword ? { password: webuiPassword } : null,
  };

  const server = createApp(opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    configPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authHeader(password: string, username = "anything"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("web UI routes 503 when WEBUI_PASSWORD isn't configured", async () => {
  const { baseUrl, close } = await makeScratchServer(null);
  try {
    const res = await fetch(`${baseUrl}/api/shows`);
    assert.equal(res.status, 503);
  } finally {
    await close();
  }
});

test("web UI routes 401 with no or wrong credentials, and set WWW-Authenticate", async () => {
  const { baseUrl, close } = await makeScratchServer("correct-password");
  try {
    const noAuth = await fetch(`${baseUrl}/api/shows`);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("www-authenticate") ?? "", /Basic/);

    const wrongAuth = await fetch(`${baseUrl}/api/shows`, {
      headers: { Authorization: authHeader("wrong-password") },
    });
    assert.equal(wrongAuth.status, 401);
  } finally {
    await close();
  }
});

test("GET /api/shows returns the config when authorized (any username, correct password)", async () => {
  const { baseUrl, close } = await makeScratchServer("correct-password");
  try {
    const res = await fetch(`${baseUrl}/api/shows`, {
      headers: { Authorization: authHeader("correct-password", "someuser") },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { shows: Array<{ id: string }> };
    assert.equal(body.shows.length, 1);
    assert.equal(body.shows[0].id, "tdf");
  } finally {
    await close();
  }
});

test("PUT /api/shows persists a valid config and rejects an invalid one without writing", async () => {
  const { baseUrl, configPath, close } = await makeScratchServer("correct-password");
  try {
    const valid = {
      shows: [
        { id: "tdf", folderName: "Tour de France", matchKeywords: ["tour de france", "tdf"], type: "stage-race" },
        { id: "giro", folderName: "Giro", matchKeywords: ["giro"], type: "stage-race" },
      ],
    };
    const putRes = await fetch(`${baseUrl}/api/shows`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    });
    assert.equal(putRes.status, 200);
    const onDisk = JSON.parse(await fs.readFile(configPath, "utf-8"));
    assert.equal(onDisk.shows.length, 2);

    const invalid = { shows: [{ id: "dup" }, { id: "dup" }] };
    const badRes = await fetch(`${baseUrl}/api/shows`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    });
    assert.equal(badRes.status, 400);
    const stillOnDisk = JSON.parse(await fs.readFile(configPath, "utf-8"));
    assert.equal(stillOnDisk.shows.length, 2); // unchanged from the valid PUT above, not overwritten with garbage
  } finally {
    await close();
  }
});

test("POST /api/match-test never persists, even when it would auto-create", async () => {
  const { baseUrl, configPath, close } = await makeScratchServer("correct-password");
  try {
    const before = await fs.readFile(configPath, "utf-8");

    const matchRes = await fetch(`${baseUrl}/api/match-test`, {
      method: "POST",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tour-de-France-2026-Stage-05-1080p" }),
    });
    assert.equal(matchRes.status, 200);
    const matchBody = (await matchRes.json()) as { match: { showId: string; autoCreated: boolean } };
    assert.equal(matchBody.match.showId, "tdf");
    assert.equal(matchBody.match.autoCreated, false);

    const autoCreateRes = await fetch(`${baseUrl}/api/match-test`, {
      method: "POST",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Some-Totally-Unknown-Race-2026-Stage-02" }),
    });
    assert.equal(autoCreateRes.status, 200);
    const autoCreateBody = (await autoCreateRes.json()) as { match: { autoCreated: boolean } };
    assert.equal(autoCreateBody.match.autoCreated, true);

    const after = await fs.readFile(configPath, "utf-8");
    assert.equal(after, before); // neither call wrote anything to disk
  } finally {
    await close();
  }
});

test("GET /api/activity and /api/status respond with the expected shape", async () => {
  const { baseUrl, close } = await makeScratchServer("correct-password");
  try {
    const activityRes = await fetch(`${baseUrl}/api/activity`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    assert.equal(activityRes.status, 200);
    const activityBody = (await activityRes.json()) as { events: unknown[] };
    assert.ok(Array.isArray(activityBody.events));

    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { plex: { enabled: boolean }; discord: { enabled: boolean } };
    assert.equal(statusBody.plex.enabled, false);
    assert.equal(statusBody.discord.enabled, false);
  } finally {
    await close();
  }
});

test("GET /ui serves the HTML page when authorized", async () => {
  const { baseUrl, close } = await makeScratchServer("correct-password");
  try {
    const res = await fetch(`${baseUrl}/ui`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Domestique<\/title>/);
  } finally {
    await close();
  }
});
