import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDedupeOriginal, getDedupeOriginal, clearDedupeOriginal } from "../src/dedupeState.js";

async function scratchPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-dedupe-state-"));
  return join(dir, "dedupe-state.json");
}

test("recordDedupeOriginal + getDedupeOriginal: round-trips a recorded entry", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Some Torrent", { dir: "/downloads/complete", name: "Some Torrent" }, path);
  assert.deepEqual(getDedupeOriginal("Some Torrent", path), { dir: "/downloads/complete", name: "Some Torrent" });
});

test("getDedupeOriginal: returns undefined for a torrent that's never been recorded", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Recorded Torrent", { dir: "/downloads", name: "Recorded Torrent" }, path);
  assert.equal(getDedupeOriginal("Never Recorded", path), undefined);
});

test("recordDedupeOriginal: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Some Torrent", { dir: "/downloads/complete", name: "Some Torrent" }, path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk["Some Torrent"], { dir: "/downloads/complete", name: "Some Torrent" });
});

test("getDedupeOriginal: rehydrates from an already-persisted file on first access - what a restart looks like", async () => {
  const path = await scratchPath();
  // Written directly to disk, never through recordDedupeOriginal - simulates
  // what's already there from a previous process's lifetime.
  await fs.writeFile(path, JSON.stringify({ "From Before Restart": { dir: "/downloads", name: "From Before Restart" } }), "utf-8");

  assert.deepEqual(getDedupeOriginal("From Before Restart", path), { dir: "/downloads", name: "From Before Restart" });
});

test("getDedupeOriginal: seeds a missing file rather than crashing (first-boot bind-mount case)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-dedupe-state-"));
  const path = join(dir, "dedupe-state.json"); // deliberately never created

  assert.equal(getDedupeOriginal("Anything", path), undefined);
  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk, {});
});

test("recordDedupeOriginal: recording again for the same torrent name overwrites the old entry", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Some Torrent", { dir: "/downloads/old-location", name: "Some Torrent" }, path);
  recordDedupeOriginal("Some Torrent", { dir: "/downloads/new-location", name: "Some Torrent" }, path);
  assert.deepEqual(getDedupeOriginal("Some Torrent", path), { dir: "/downloads/new-location", name: "Some Torrent" });
});

test("clearDedupeOriginal: removes a recorded entry, and other entries are untouched", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Torrent A", { dir: "/downloads", name: "Torrent A" }, path);
  recordDedupeOriginal("Torrent B", { dir: "/downloads", name: "Torrent B" }, path);

  clearDedupeOriginal("Torrent A", path);

  assert.equal(getDedupeOriginal("Torrent A", path), undefined);
  assert.deepEqual(getDedupeOriginal("Torrent B", path), { dir: "/downloads", name: "Torrent B" });
});

test("clearDedupeOriginal: clearing a torrent with no recorded entry is a harmless no-op", async () => {
  const path = await scratchPath();
  clearDedupeOriginal("Never Recorded", path);
  assert.equal(getDedupeOriginal("Never Recorded", path), undefined);
});

test("clearDedupeOriginal: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordDedupeOriginal("Some Torrent", { dir: "/downloads", name: "Some Torrent" }, path);
  clearDedupeOriginal("Some Torrent", path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.equal("Some Torrent" in onDisk, false);
});
