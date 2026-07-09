import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateStability, pollHotfolder, type HotfolderConfig } from "../src/hotfolder.js";
import type { ServerOptions } from "../src/server.js";

test("updateStability: unchanged size/mtime increments stableCount until threshold", () => {
  const requiredPolls = 3;
  const snapshot = { size: 100, mtimeMs: 12345 };

  const first = updateStability(undefined, snapshot, requiredPolls);
  assert.equal(first.state.stableCount, 1);
  assert.equal(first.isStable, false);

  const second = updateStability(first.state, snapshot, requiredPolls);
  assert.equal(second.state.stableCount, 2);
  assert.equal(second.isStable, false);

  const third = updateStability(second.state, snapshot, requiredPolls);
  assert.equal(third.state.stableCount, 3);
  assert.equal(third.isStable, true);
});

test("updateStability: a size/mtime change resets stableCount to 1", () => {
  const requiredPolls = 3;
  const first = updateStability(undefined, { size: 100, mtimeMs: 1 }, requiredPolls);
  const second = updateStability(first.state, { size: 100, mtimeMs: 1 }, requiredPolls);
  assert.equal(second.state.stableCount, 2);

  // still growing (mid-copy) -> resets
  const third = updateStability(second.state, { size: 200, mtimeMs: 2 }, requiredPolls);
  assert.equal(third.state.stableCount, 1);
  assert.equal(third.isStable, false);
});

async function makeScratch() {
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-library-"));
  const hotfolderDir = await fs.mkdtemp(join(tmpdir(), "domestique-hotfolder-"));
  // Deliberately a separate directory from hotfolderDir — pollHotfolder
  // treats every non-dotfile top-level entry in the watch dir as a drop, so
  // the config file can't live inside it.
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-config-"));
  const configPath = join(configDir, "shows.json");
  return { libraryRoot, hotfolderDir, configPath };
}

function makeOpts(libraryRoot: string, configPath: string): ServerOptions {
  return { port: 0, libraryRoot, configPath, plex: null };
}

async function writeMinimalConfig(configPath: string) {
  await fs.writeFile(
    configPath,
    JSON.stringify({ shows: [] }) + "\n",
    "utf-8"
  );
}

test("pollHotfolder: leaves a not-yet-stable drop untouched", async () => {
  const { libraryRoot, hotfolderDir, configPath } = await makeScratch();
  await writeMinimalConfig(configPath);

  await fs.writeFile(join(hotfolderDir, "Some-Race-2026-Stage-01.mp4"), "dummy");

  const config: HotfolderConfig = {
    dir: hotfolderDir,
    processedDir: join(hotfolderDir, "processed"),
    pollIntervalMs: 1,
    stablePolls: 2,
  };
  const opts = makeOpts(libraryRoot, configPath);
  const state = new Map();

  await pollHotfolder(config, opts, state); // poll 1: first sighting, not stable yet

  const stillThere = await fs.stat(join(hotfolderDir, "Some-Race-2026-Stage-01.mp4"));
  assert.ok(stillThere.isFile());
  assert.equal(await fs.stat(config.processedDir).catch(() => null), null);
});

test("pollHotfolder: processes a drop once stable and moves it to processed/", async () => {
  const { libraryRoot, hotfolderDir, configPath } = await makeScratch();
  await writeMinimalConfig(configPath);

  const fileName = "Some-Unknown-Race-2026-Stage-02.mp4";
  await fs.writeFile(join(hotfolderDir, fileName), "dummy");

  const config: HotfolderConfig = {
    dir: hotfolderDir,
    processedDir: join(hotfolderDir, "processed"),
    pollIntervalMs: 1,
    stablePolls: 2,
  };
  const opts = makeOpts(libraryRoot, configPath);
  const state = new Map();

  await pollHotfolder(config, opts, state); // poll 1: not stable
  await pollHotfolder(config, opts, state); // poll 2: stable -> processed

  // original moved out of the watch folder root
  await assert.rejects(fs.stat(join(hotfolderDir, fileName)));

  // and landed in processed/
  const processedStat = await fs.stat(join(config.processedDir, fileName));
  assert.ok(processedStat.isFile());

  // and actually got archived into the library (auto-created show, since
  // the config started empty)
  const showDirs = await fs.readdir(libraryRoot);
  assert.equal(showDirs.length, 1);
});

test("pollHotfolder: a same-named second drop into processed/ gets a suffixed name, not overwritten", async () => {
  const { libraryRoot, hotfolderDir, configPath } = await makeScratch();
  await writeMinimalConfig(configPath);

  const fileName = "Repeat-Drop-2026-Stage-03.mp4";
  const config: HotfolderConfig = {
    dir: hotfolderDir,
    processedDir: join(hotfolderDir, "processed"),
    pollIntervalMs: 1,
    stablePolls: 1,
  };
  const opts = makeOpts(libraryRoot, configPath);

  // First drop, processed immediately (stablePolls: 1).
  await fs.writeFile(join(hotfolderDir, fileName), "first");
  await pollHotfolder(config, opts, new Map());
  assert.equal((await fs.readFile(join(config.processedDir, fileName), "utf-8")), "first");

  // Second drop with the exact same original filename.
  await fs.writeFile(join(hotfolderDir, fileName), "second");
  await pollHotfolder(config, opts, new Map());

  const processedEntries = await fs.readdir(config.processedDir);
  assert.equal(processedEntries.length, 2);
  assert.ok(processedEntries.includes(fileName));
  assert.ok(processedEntries.includes(`${fileName} (2)`));
});
