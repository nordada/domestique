import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type ShowsConfigFile } from "../src/config.js";

async function makeScratchDir() {
  return fs.mkdtemp(join(tmpdir(), "domestique-config-"));
}

test("loadConfig seeds a missing path from the bundled default config", async () => {
  const scratch = await makeScratchDir();
  const configPath = join(scratch, "appdata", "config", "events.json");

  const config = loadConfig(configPath);
  assert.ok(config.shows.length > 0, "seeded config should carry the bundled default's entries");
  const onDisk = JSON.parse(await fs.readFile(configPath, "utf-8")) as ShowsConfigFile;
  assert.deepEqual(onDisk, config);
});

test("loadConfig recovers from Docker's bind-mount gotcha (empty directory in place of the file)", async () => {
  const scratch = await makeScratchDir();
  const configPath = join(scratch, "events.json");
  mkdirSync(configPath); // simulates Docker auto-creating a dir for a missing bind-mount source

  const config = loadConfig(configPath);
  assert.ok(config.shows.length > 0);
  const stat = await fs.stat(configPath);
  assert.ok(stat.isFile(), "the empty directory should have been replaced with the seeded file");
});

test("loadConfig throws a clear error for a non-empty directory in place of the file", async () => {
  const scratch = await makeScratchDir();
  const configPath = join(scratch, "events.json");
  mkdirSync(configPath);
  await fs.writeFile(join(configPath, "stray-file"), "oops");

  assert.throws(() => loadConfig(configPath), /non-empty directory/);
});

test("loadConfig loads an existing file as-is, without touching it", async () => {
  const scratch = await makeScratchDir();
  const configPath = join(scratch, "events.json");
  const custom: ShowsConfigFile = {
    shows: [{ id: "custom-race", folderName: "Custom Race", matchKeywords: ["custom race"], type: "one-day" }],
  };
  saveConfig(custom, configPath);

  const loaded = loadConfig(configPath);
  assert.deepEqual(loaded, custom);
});
