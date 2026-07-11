import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings, setPaused } from "../src/settings.js";

async function makeScratchDir() {
  return fs.mkdtemp(join(tmpdir(), "domestique-settings-"));
}

const ENV_KEYS = [
  "PLEX_URL",
  "PLEX_TOKEN",
  "PLEX_SECTION_ID",
  "PLEX_LIBRARY_ROOT",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_MENTION_USER_ID",
  "HOTFOLDER_DIR",
  "HOTFOLDER_POLL_INTERVAL_MS",
  "HOTFOLDER_STABLE_POLLS",
] as const;

function withEnv<T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => T): T {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("loadSettings seeds a missing path from the current env vars", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "appdata", "settings.json");

  withEnv(
    {
      PLEX_URL: "http://192.168.1.24:32400",
      PLEX_TOKEN: "abc123",
      PLEX_SECTION_ID: "5",
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
      HOTFOLDER_DIR: "/downloads/domestique",
    },
    () => {
      const settings = loadSettings(settingsPath, "/library");
      assert.deepEqual(settings.plex, {
        url: "http://192.168.1.24:32400",
        token: "abc123",
        sectionId: "5",
        libraryRoot: "/library",
      });
      assert.deepEqual(settings.discord, { webhookUrl: "https://discord.example/webhook", mentionUserId: undefined });
      assert.deepEqual(settings.hotfolder, {
        dir: "/downloads/domestique",
        pollIntervalMs: 60000,
        stablePolls: 3,
        acknowledgeNoSeedback: false,
      });
    }
  );

  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
  assert.equal(onDisk.plex.token, "abc123");
});

test("loadSettings seeds fully disabled when no relevant env vars are set", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  withEnv({}, () => {
    const settings = loadSettings(settingsPath, "/library");
    assert.equal(settings.plex, null);
    assert.equal(settings.discord, null);
    assert.equal(settings.hotfolder, null);
  });
});

test("loadSettings recovers from Docker's bind-mount gotcha (empty directory in place of the file)", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");
  mkdirSync(settingsPath);

  const settings = withEnv({}, () => loadSettings(settingsPath, "/library"));
  assert.equal(settings.plex, null);
  const stat = await fs.stat(settingsPath);
  assert.ok(stat.isFile());
});

test("loadSettings seeds an existing but empty (0-byte) file, e.g. touched on the host as a placeholder", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");
  await fs.writeFile(settingsPath, "");

  const settings = withEnv({}, () => loadSettings(settingsPath, "/library"));
  assert.equal(settings.plex, null);
  assert.equal(settings.discord, null);
  assert.equal(settings.hotfolder, null);
});

test("saveSettings + loadSettings round-trip, and normalizes partial Plex fields to disabled", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  const saved = saveSettings(
    {
      plex: { url: "http://plex.local:32400", sectionId: "35" }, // no token - collapses to null
      discord: { webhookUrl: "https://discord.example/webhook", mentionUserId: "999" },
      hotfolder: { dir: "/downloads/domestique", pollIntervalMs: 5000, stablePolls: 2, acknowledgeNoSeedback: true },
      transmission: { url: "http://tower:9091/transmission/rpc/", username: "admin", password: "hunter2" },
    },
    "/library",
    settingsPath
  );

  assert.equal(saved.plex, null);
  assert.deepEqual(saved.discord, { webhookUrl: "https://discord.example/webhook", mentionUserId: "999" });
  assert.deepEqual(saved.hotfolder, {
    dir: "/downloads/domestique",
    pollIntervalMs: 5000,
    stablePolls: 2,
    acknowledgeNoSeedback: true,
  });
  assert.deepEqual(saved.transmission, {
    url: "http://tower:9091/transmission/rpc", // trailing slash stripped
    username: "admin",
    password: "hunter2",
  });

  const reloaded = loadSettings(settingsPath, "/library");
  assert.deepEqual(reloaded, saved);
});

test("normalizeTransmission collapses to null without a url, and drops blank username/password", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  const noUrl = saveSettings({ transmission: { username: "admin", password: "hunter2" } }, "/library", settingsPath);
  assert.equal(noUrl.transmission, null);

  const blankExtras = saveSettings(
    { transmission: { url: "http://tower:9091/transmission/rpc", username: "  ", password: "" } },
    "/library",
    settingsPath
  );
  assert.deepEqual(blankExtras.transmission, {
    url: "http://tower:9091/transmission/rpc",
    username: undefined,
    password: undefined,
  });
});

test("saveSettings resolves a blank Plex library-root override to the app's own library root", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  const saved = saveSettings(
    { plex: { url: "http://plex.local:32400", sectionId: "35", token: "tok" } },
    "/library",
    settingsPath
  );

  assert.equal(saved.plex?.libraryRoot, "/library");
});

test("loadSettings defaults paused to false when seeding fresh, and setPaused flips it without touching other settings", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  const seeded = withEnv({ HOTFOLDER_DIR: "/downloads/domestique" }, () => loadSettings(settingsPath, "/library"));
  assert.equal(seeded.paused, false);

  const paused = setPaused(true, "/library", settingsPath);
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.hotfolder, {
    dir: "/downloads/domestique",
    pollIntervalMs: 60000,
    stablePolls: 3,
    acknowledgeNoSeedback: false,
  });

  const resumed = setPaused(false, "/library", settingsPath);
  assert.equal(resumed.paused, false);
});

test("saveSettings falls back invalid hot-folder tuning numbers to defaults instead of NaN", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  const saved = saveSettings(
    { hotfolder: { dir: "/downloads/domestique", pollIntervalMs: "not-a-number", stablePolls: -1 } },
    "/library",
    settingsPath
  );

  assert.equal(saved.hotfolder?.pollIntervalMs, 60000);
  assert.equal(saved.hotfolder?.stablePolls, 3);
});

test("saveSettings accepts a valid 6-digit hex accentColor, normalizes case, and rejects anything else", async () => {
  const scratch = await makeScratchDir();
  const settingsPath = join(scratch, "settings.json");

  assert.equal(saveSettings({ accentColor: "#3B82F6" }, "/library", settingsPath).accentColor, "#3B82F6");
  assert.equal(saveSettings({ accentColor: "#zzz111" }, "/library", settingsPath).accentColor, null);
  assert.equal(saveSettings({ accentColor: "#fff" }, "/library", settingsPath).accentColor, null); // 3-digit shorthand not accepted
  assert.equal(saveSettings({ accentColor: "" }, "/library", settingsPath).accentColor, null);
  assert.equal(saveSettings({}, "/library", settingsPath).accentColor, null);
});
