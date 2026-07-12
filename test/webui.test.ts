import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createApp, type ServerOptions } from "../src/server.js";
import { webUiConfigFromEnv, nextLockoutCooldownSeconds } from "../src/webui.js";

test("webUiConfigFromEnv returns null unless WEBUI_PASSWORD is set, and picks up WEBUI_USER when present", () => {
  const saved = { WEBUI_PASSWORD: process.env.WEBUI_PASSWORD, WEBUI_USER: process.env.WEBUI_USER };
  try {
    delete process.env.WEBUI_PASSWORD;
    delete process.env.WEBUI_USER;
    assert.equal(webUiConfigFromEnv(), null);

    process.env.WEBUI_PASSWORD = "hunter2";
    assert.deepEqual(webUiConfigFromEnv(), { password: "hunter2", username: undefined });

    process.env.WEBUI_USER = "admin";
    assert.deepEqual(webUiConfigFromEnv(), { password: "hunter2", username: "admin" });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function makeScratchServer(webui: { password: string; username?: string } | null) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-webui-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-webui-library-"));
  const configPath = join(configDir, "events.json");
  const settingsPath = join(configDir, "settings.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      shows: [{ id: "tdf", folderName: "Tour de France", matchKeywords: ["tour de france", "tdf"], type: "stage-race" }],
    }) + "\n",
    "utf-8"
  );
  // Pre-written (rather than left to env-var seeding) so tests are
  // deterministic regardless of what's in the shell's own environment.
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    downloadsPath: "/nonexistent",
    webui,
  };

  const server = createApp(opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    configPath,
    settingsPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authHeader(password: string, username = "anything"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("GET / redirects to /ui, unauthenticated and regardless of whether the web UI is enabled", async () => {
  const enabled = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${enabled.baseUrl}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/ui");
  } finally {
    await enabled.close();
  }

  const disabled = await makeScratchServer(null);
  try {
    const res = await fetch(`${disabled.baseUrl}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/ui");
  } finally {
    await disabled.close();
  }
});

test("web UI routes 503 when WEBUI_PASSWORD isn't configured", async () => {
  const { baseUrl, close } = await makeScratchServer(null);
  try {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 503);
  } finally {
    await close();
  }
});

test("web UI routes 401 with no or wrong credentials, and set WWW-Authenticate", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const noAuth = await fetch(`${baseUrl}/api/events`);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("www-authenticate") ?? "", /Basic/);

    const wrongAuth = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: authHeader("wrong-password") },
    });
    assert.equal(wrongAuth.status, 401);
  } finally {
    await close();
  }
});

test("GET /api/events returns the config when authorized (any username, correct password)", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${baseUrl}/api/events`, {
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

test("PUT /api/events persists a valid config and rejects an invalid one without writing", async () => {
  const { baseUrl, configPath, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const valid = {
      shows: [
        { id: "tdf", folderName: "Tour de France", matchKeywords: ["tour de france", "tdf"], type: "stage-race" },
        { id: "giro", folderName: "Giro", matchKeywords: ["giro"], type: "stage-race" },
      ],
    };
    const putRes = await fetch(`${baseUrl}/api/events`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    });
    assert.equal(putRes.status, 200);
    const onDisk = JSON.parse(await fs.readFile(configPath, "utf-8"));
    assert.equal(onDisk.shows.length, 2);

    const invalid = { shows: [{ id: "dup" }, { id: "dup" }] };
    const badRes = await fetch(`${baseUrl}/api/events`, {
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
  const { baseUrl, configPath, close } = await makeScratchServer({ password: "correct-password" });
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
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
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
    const statusBody = (await statusRes.json()) as {
      version: string;
      plex: { enabled: boolean };
      discord: { enabled: boolean };
      transmission: { enabled: boolean; live: boolean };
      indexer: { enabled: boolean; live: boolean };
      downloads: { reachable: boolean };
    };
    assert.equal(statusBody.plex.enabled, false);
    assert.equal(statusBody.discord.enabled, false);
    assert.equal(statusBody.transmission.enabled, false);
    assert.equal(statusBody.transmission.live, false);
    assert.equal(statusBody.indexer.enabled, false);
    assert.equal(statusBody.indexer.live, false);
    // makeScratchServer points downloadsPath at a path that doesn't exist.
    assert.equal(statusBody.downloads.reachable, false);
    assert.equal(typeof statusBody.version, "string");
    assert.ok(statusBody.version.length > 0);
  } finally {
    await close();
  }
});

test("GET /api/settings starts fully masked/disabled, and PUT saves + masks secrets in its response", async () => {
  const { baseUrl, settingsPath, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const getRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    assert.equal(getRes.status, 200);
    const initial = await getRes.json();
    assert.deepEqual(initial, {
      plex: { url: "", sectionId: "", libraryRoot: "", tokenSet: false },
      discord: { mentionUserId: "", webhookUrlSet: false },
      hotfolder: { dir: "", pollIntervalMs: 60000, stablePolls: 3, acknowledgeNoSeedback: false },
      transmission: { url: "", username: "", passwordSet: false },
      indexer: { url: "", checkIntervalMs: 300000 },
      paused: false,
      accentColor: "",
      statusPollIntervalMs: 20000,
      statusPollWhenHidden: false,
      webhookSecretSet: false,
      loginLockoutThreshold: 5,
      loginLockoutSeconds: 60,
    });

    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({
        plex: { url: "http://plex.local:32400", sectionId: "35" },
        plexToken: "secret-token",
        discord: { mentionUserId: "12345" },
        discordWebhookUrl: "https://discord.example/webhook",
        hotfolder: { dir: "/downloads/domestique", pollIntervalMs: 5000, stablePolls: 2 },
        transmission: { url: "http://tower:9091/transmission/rpc", username: "admin" },
        transmissionPassword: "secret-password",
        indexer: { url: "https://indexer.example", checkIntervalMs: 60000 },
        accentColor: "#22c55e",
        webhookSecret: "shh-its-a-secret",
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    // The raw secrets are never echoed back, only whether one is set.
    assert.equal(putBody.plex.tokenSet, true);
    assert.equal(putBody.discord.webhookUrlSet, true);
    assert.equal(putBody.plex.url, "http://plex.local:32400");
    assert.equal(putBody.hotfolder.pollIntervalMs, 5000);
    assert.equal(putBody.transmission.passwordSet, true);
    assert.equal(putBody.transmission.url, "http://tower:9091/transmission/rpc");
    assert.equal(putBody.indexer.url, "https://indexer.example");
    assert.equal(putBody.indexer.checkIntervalMs, 60000);
    assert.equal(putBody.accentColor, "#22c55e");
    assert.equal(putBody.webhookSecretSet, true);
    assert.ok(!("token" in putBody.plex));
    assert.ok(!("webhookUrl" in putBody.discord));
    assert.ok(!("password" in putBody.transmission));
    assert.ok(!("webhookSecret" in putBody));

    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.equal(onDisk.plex.token, "secret-token");
    assert.equal(onDisk.discord.webhookUrl, "https://discord.example/webhook");
    assert.equal(onDisk.transmission.password, "secret-password");
    assert.equal(onDisk.indexer.url, "https://indexer.example");
    assert.equal(onDisk.accentColor, "#22c55e");
    assert.equal(onDisk.webhookSecret, "shh-its-a-secret");
  } finally {
    await close();
  }
});

test("nextLockoutCooldownSeconds doubles per repeat trigger and caps at 30 minutes", () => {
  assert.equal(nextLockoutCooldownSeconds(60, 0), 60);
  assert.equal(nextLockoutCooldownSeconds(60, 1), 120);
  assert.equal(nextLockoutCooldownSeconds(60, 2), 240);
  assert.equal(nextLockoutCooldownSeconds(60, 5), 1800); // 60 * 2^5 = 1920, clamped to the 1800s (30min) cap
  assert.equal(nextLockoutCooldownSeconds(60, 20), 1800); // stays capped, doesn't grow unbounded
});

test("web UI login lockout: locks out after N failures with the correct Retry-After, then auto-expires with no restart involved", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    // loginLockoutSeconds is clamped to a 10s floor (see settings.ts's
    // MIN_LOGIN_LOCKOUT_SECONDS): that's the shortest this test can
    // legitimately configure, so it's also the shortest it can wait.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ loginLockoutThreshold: 3, loginLockoutSeconds: 10 }),
    });

    const badLogin = () => fetch(`${baseUrl}/api/settings`, { headers: { Authorization: authHeader("wrong-password") } });
    const goodLogin = () => fetch(`${baseUrl}/api/settings`, { headers: { Authorization: authHeader("correct-password") } });

    // The 3rd failure itself is still an ordinary 401, not a 429: the
    // lockout takes effect starting with the NEXT request.
    assert.equal((await badLogin()).status, 401);
    assert.equal((await badLogin()).status, 401);
    assert.equal((await badLogin()).status, 401);

    const lockedRes = await goodLogin();
    assert.equal(lockedRes.status, 429);
    assert.ok(Number(lockedRes.headers.get("retry-after")) >= 9);

    await new Promise((resolveWait) => setTimeout(resolveWait, 10500));

    // Auto-expired with no restart involved, and a correct login now succeeds.
    assert.equal((await goodLogin()).status, 200);
  } finally {
    await close();
  }
});

test("web UI login lockout posts a Discord notification exactly once per trigger, not on every subsequent 429", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  const discordCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = global.fetch;
  // Both the test's own requests to baseUrl AND the server's outgoing
  // Discord webhook call go through global.fetch in this same process -
  // only intercept the Discord URL specifically, delegate everything else
  // to the real fetch so the test's own HTTP calls still work.
  global.fetch = (async (url, init) => {
    if (typeof url === "string" && url.includes("discord.example")) {
      discordCalls.push({ url, body: JSON.parse((init as { body: string }).body) });
      return { ok: true } as Response;
    }
    return originalFetch(url as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
  }) as typeof fetch;

  try {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({
        discord: { mentionUserId: "12345" },
        discordWebhookUrl: "https://discord.example/webhook",
        loginLockoutThreshold: 3,
        loginLockoutSeconds: 10,
      }),
    });

    const badLogin = () => fetch(`${baseUrl}/api/settings`, { headers: { Authorization: authHeader("wrong-password") } });
    await badLogin();
    await badLogin();
    await badLogin(); // the 3rd failure crosses the threshold and triggers the lockout

    // The notification is fire-and-forget (doesn't block the HTTP
    // response), so give it a moment to actually land.
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    assert.equal(discordCalls.length, 1);
    assert.match(discordCalls[0].body.content as string, /Login lockout triggered/);
    assert.match(discordCalls[0].body.content as string, /3 failed/);

    // A further request while still locked out (429, not a fresh trigger)
    // must not post a second notification.
    await badLogin();
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.equal(discordCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
    await close();
  }
});

test("PUT /api/settings omitting a secret keeps the existing one; sending an empty string clears it", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({
        plex: { url: "http://plex.local:32400", sectionId: "35" },
        plexToken: "secret-token",
      }),
    });

    // Omitting plexToken entirely should keep the stored one - Plex stays enabled.
    const keepRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ plex: { url: "http://plex.local:32400", sectionId: "35" } }),
    });
    const keepBody = await keepRes.json();
    assert.equal(keepBody.plex.tokenSet, true);

    // Explicitly sending an empty token clears it, collapsing Plex to disabled.
    const clearRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ plex: { url: "http://plex.local:32400", sectionId: "35" }, plexToken: "" }),
    });
    const clearBody = await clearRes.json();
    assert.equal(clearBody.plex.tokenSet, false);
  } finally {
    await close();
  }
});

test("PUT /api/paused toggles the global pause flag, reflected in /api/status, and survives a PUT /api/settings save", async () => {
  const { baseUrl, settingsPath, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const pauseRes = await fetch(`${baseUrl}/api/paused`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(pauseRes.status, 200);
    const pauseBody = await pauseRes.json();
    assert.equal(pauseBody.paused, true);

    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    const statusBody = await statusRes.json();
    assert.equal(statusBody.paused, true);

    // Saving unrelated settings (e.g. from the Settings page) must not
    // silently clear the pause flag.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ hotfolder: { dir: "/downloads/domestique" } }),
    });
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.equal(onDisk.paused, true);

    const resumeRes = await fetch(`${baseUrl}/api/paused`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    assert.equal((await resumeRes.json()).paused, false);
  } finally {
    await close();
  }
});

test("POST /webhook/torrent-done is skipped without side effects while paused", async () => {
  const { baseUrl, settingsPath, close } = await makeScratchServer({ password: "correct-password" });
  try {
    await fetch(`${baseUrl}/api/paused`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    const res = await fetch(`${baseUrl}/webhook/torrent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "/nonexistent", name: "Tour-de-France-2026-Stage-05.mp4" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.paused, true);
    assert.deepEqual(body.results, []);

    const activityRes = await fetch(`${baseUrl}/api/activity`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    const activityBody = await activityRes.json();
    assert.equal(activityBody.events.length, 0);

    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.equal(onDisk.paused, true);
  } finally {
    await close();
  }
});

test("POST /webhook/torrent-done requires a matching X-Webhook-Secret once one is configured, but stays open when unset", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    // Paused, so an authorized request short-circuits at 200 before ever
    // touching the filesystem: isolates the secret check itself from real
    // file processing, which this scratch server isn't set up for.
    await fetch(`${baseUrl}/api/paused`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    const call = (headers) =>
      fetch(`${baseUrl}/webhook/torrent-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ dir: "/nonexistent", name: "Tour-de-France-2026-Stage-05.mp4" }),
      });

    // No secret configured yet: original open behavior, no header needed.
    assert.equal((await call({})).status, 200);

    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ webhookSecret: "correct-horse-battery-staple" }),
    });

    assert.equal((await call({})).status, 401);
    assert.equal((await call({ "X-Webhook-Secret": "wrong-guess" })).status, 401);
    assert.equal((await call({ "X-Webhook-Secret": "correct-horse-battery-staple" })).status, 200);

    // Clearing it (empty string, same convention as the other secret
    // fields) restores the original open behavior.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ webhookSecret: "" }),
    });
    assert.equal((await call({})).status, 200);
  } finally {
    await close();
  }
});

test("POST /webhook/torrent-done rejects a dir/name that resolves outside the downloads share", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    // Paused, so a request that DOES pass the confinement check short-
    // circuits cleanly at 200 rather than hitting the real filesystem.
    await fetch(`${baseUrl}/api/paused`, {
      method: "PUT",
      headers: { Authorization: authHeader("correct-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    const call = (dir, name) =>
      fetch(`${baseUrl}/webhook/torrent-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir, name }),
      });

    // A dir entirely outside the configured downloads share (/nonexistent
    // in this scratch server) is rejected outright, regardless of pause
    // state or whether a webhookSecret is even configured: this check
    // doesn't depend on the secret at all.
    const outsideRes = await call("/etc", "passwd");
    assert.equal(outsideRes.status, 400);
    assert.match((await outsideRes.json()).error, /downloads share/);

    // A dir that looks like it's inside the share, but escapes via the
    // name field's own "../" segments, is caught too: the check runs on
    // the fully joined path, not dir alone.
    const escapeRes = await call("/nonexistent", "../../etc/passwd");
    assert.equal(escapeRes.status, 400);

    // A dir/name combo that genuinely resolves inside the configured
    // share passes the check, then hits the paused short-circuit, proving
    // it got past this check specifically rather than failing some other
    // way.
    const insideRes = await call("/nonexistent", "Tour-de-France-2026-Stage-05.mp4");
    assert.equal(insideRes.status, 200);
  } finally {
    await close();
  }
});

test("GET /ui serves the HTML page when authorized", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
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

test("when WEBUI_USER is configured, both username and password must match", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password", username: "admin" });
  try {
    const rightUserRightPass = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: authHeader("correct-password", "admin") },
    });
    assert.equal(rightUserRightPass.status, 200);

    const wrongUserRightPass = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: authHeader("correct-password", "someoneelse") },
    });
    assert.equal(wrongUserRightPass.status, 401);

    const rightUserWrongPass = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: authHeader("wrong-password", "admin") },
    });
    assert.equal(rightUserWrongPass.status, 401);
  } finally {
    await close();
  }
});

/** Minimal fake Transmission RPC server, just enough to exercise POST /api/transmission/add-torrent end to end. */
function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-webui";
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

test("POST /api/transmission/add-torrent without Transmission configured logs to activity and returns 400", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${baseUrl}/api/transmission/add-torrent?name=stage05.torrent`, {
      method: "POST",
      headers: { Authorization: authHeader("correct-password") },
      body: Buffer.from("fake torrent bytes"),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not.*configured|isn't configured/i);

    // Checks the newest entry (index 0, recordActivity unshifts) rather
    // than an absolute activity.events.length - the activity log is
    // process-global shared state across every test in this file, not
    // reset between tests.
    const activityRes = await fetch(`${baseUrl}/api/activity`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    const activity = await activityRes.json();
    assert.equal(activity.events[0].torrentName, "stage05.torrent");
    assert.equal(activity.events[0].reviewWorthy, true);
    assert.match(activity.events[0].lines[0], /isn't configured/);
  } finally {
    await close();
  }
});

test("POST /api/transmission/add-torrent adds, polls to confirm, and logs a success activity entry", async () => {
  const { baseUrl, close: closeApp, settingsPath } = await makeScratchServer({ password: "correct-password" });
  const { url: transmissionUrl, close: closeTransmission } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-add") {
      return { "torrent-added": { id: 11, name: "Tour de France Stage 5", hashString: "abc123" } };
    }
    if (method === "torrent-get") {
      return { torrents: [{ id: 11, status: 4, error: 0, errorString: "" }] };
    }
    return {};
  });
  try {
    // Seed transmission settings directly (bypassing PUT /api/settings -
    // this test only cares about the add-torrent route, not settings
    // round-tripping, which is already covered elsewhere).
    const current = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ ...current, transmission: { url: transmissionUrl } }) + "\n",
      "utf-8"
    );

    const res = await fetch(`${baseUrl}/api/transmission/add-torrent?name=stage05.torrent`, {
      method: "POST",
      headers: { Authorization: authHeader("correct-password") },
      body: Buffer.from("fake torrent bytes"),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.added.name, "Tour de France Stage 5");
    assert.equal(body.confirmed, true);

    const activityRes = await fetch(`${baseUrl}/api/activity`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    const activity = await activityRes.json();
    assert.equal(activity.events[0].torrentName, "Tour de France Stage 5");
    assert.equal(activity.events[0].reviewWorthy, false);
    assert.match(activity.events[0].lines.join("\n"), /added to Transmission/);
    assert.match(activity.events[0].lines.join("\n"), /Confirmed by Transmission/);
  } finally {
    await closeApp();
    await closeTransmission();
  }
});
