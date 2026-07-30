import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordVerifyResult, getVerifyResult } from "../src/verifyState.js";

async function scratchPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-verify-state-"));
  return join(dir, "verify-state.json");
}

test("recordVerifyResult + getVerifyResult: round-trips a recorded entry", async () => {
  const path = await scratchPath();
  const record = { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 1, clean: true };
  recordVerifyResult("abc123", record, path);
  assert.deepEqual(getVerifyResult("abc123", path), record);
});

test("getVerifyResult: returns null for a torrent that's never been verified", async () => {
  const path = await scratchPath();
  recordVerifyResult("recorded-hash", { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 1, clean: true }, path);
  assert.equal(getVerifyResult("never-recorded-hash", path), null);
});

test("recordVerifyResult: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  const record = { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 0.42, clean: false };
  recordVerifyResult("abc123", record, path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk["abc123"], record);
});

test("getVerifyResult: rehydrates from an already-persisted file on first access - what a restart looks like", async () => {
  const path = await scratchPath();
  const record = { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 1, clean: true };
  // Written directly to disk, never through recordVerifyResult - simulates
  // what's already there from a previous process's lifetime.
  await fs.writeFile(path, JSON.stringify({ "from-before-restart": record }), "utf-8");

  assert.deepEqual(getVerifyResult("from-before-restart", path), record);
});

test("getVerifyResult: seeds a missing file rather than crashing (first-boot bind-mount case)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-verify-state-"));
  const path = join(dir, "verify-state.json"); // deliberately never created

  assert.equal(getVerifyResult("anything", path), null);
  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk, {});
});

test("recordVerifyResult: recording again for the same info-hash overwrites the old entry", async () => {
  const path = await scratchPath();
  recordVerifyResult("abc123", { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 0.42, clean: false }, path);
  recordVerifyResult("abc123", { checkedAt: "2026-07-30T01:00:00.000Z", percentDone: 1, clean: true }, path);
  assert.deepEqual(getVerifyResult("abc123", path), {
    checkedAt: "2026-07-30T01:00:00.000Z",
    percentDone: 1,
    clean: true,
  });
});

test("recordVerifyResult: recording a different info-hash doesn't disturb an existing entry", async () => {
  const path = await scratchPath();
  const recordA = { checkedAt: "2026-07-30T00:00:00.000Z", percentDone: 1, clean: true };
  const recordB = { checkedAt: "2026-07-30T00:05:00.000Z", percentDone: 0.35, clean: false };
  recordVerifyResult("hash-a", recordA, path);
  recordVerifyResult("hash-b", recordB, path);

  assert.deepEqual(getVerifyResult("hash-a", path), recordA);
  assert.deepEqual(getVerifyResult("hash-b", path), recordB);
});
