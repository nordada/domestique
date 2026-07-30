import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordArchived, clearArchived, isArchived, listArchived } from "../src/archiveState.js";

async function scratchPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-archive-state-"));
  return join(dir, "archive-state.json");
}

test("recordArchived + isArchived: a recorded hash reports archived", async () => {
  const path = await scratchPath();
  recordArchived("abc123", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);
  assert.equal(isArchived("abc123", path), true);
});

test("isArchived: a hash never recorded reports not archived", async () => {
  const path = await scratchPath();
  recordArchived("recorded-hash", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);
  assert.equal(isArchived("never-recorded-hash", path), false);
});

test("isArchived: hash lookup is case-insensitive, matching how it's recorded", async () => {
  const path = await scratchPath();
  recordArchived("ABC123", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);
  assert.equal(isArchived("abc123", path), true);
});

test("clearArchived: un-archives a recorded hash", async () => {
  const path = await scratchPath();
  recordArchived("abc123", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);
  clearArchived("abc123", path);
  assert.equal(isArchived("abc123", path), false);
});

test("clearArchived: a no-op, not an error, for a hash that was never archived", async () => {
  const path = await scratchPath();
  assert.doesNotThrow(() => clearArchived("never-archived", path));
});

test("recordArchived: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordArchived("abc123", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk["abc123"], { archivedAt: "2026-07-30T00:00:00.000Z" });
});

test("isArchived: rehydrates from an already-persisted file on first access - what a restart looks like", async () => {
  const path = await scratchPath();
  await fs.writeFile(path, JSON.stringify({ "from-before-restart": { archivedAt: "2026-07-30T00:00:00.000Z" } }), "utf-8");
  assert.equal(isArchived("from-before-restart", path), true);
});

test("isArchived: seeds a missing file rather than crashing (first-boot bind-mount case)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-archive-state-"));
  const path = join(dir, "archive-state.json"); // deliberately never created

  assert.equal(isArchived("anything", path), false);
  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk, {});
});

test("listArchived: reports every currently-archived hash with its record", async () => {
  const path = await scratchPath();
  recordArchived("hash-a", { archivedAt: "2026-07-30T00:00:00.000Z" }, path);
  recordArchived("hash-b", { archivedAt: "2026-07-30T00:05:00.000Z" }, path);
  clearArchived("hash-a", path);

  assert.deepEqual(listArchived(path), { "hash-b": { archivedAt: "2026-07-30T00:05:00.000Z" } });
});
