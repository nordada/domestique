import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordManualMatch, getManualMatches, clearManualMatch } from "../src/matchOverrides.js";

async function scratchPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-match-overrides-"));
  return join(dir, "match-overrides.json");
}

test("recordManualMatch + getManualMatches: round-trips a recorded pick", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/Race - Disc 3.mp4", path);
  assert.deepEqual(getManualMatches("abc123", path), { "Race/stage1.mp4": "/library/Race - Disc 3.mp4" });
});

test("getManualMatches: returns an empty object for a torrent with nothing recorded", async () => {
  const path = await scratchPath();
  assert.deepEqual(getManualMatches("never-recorded", path), {});
});

test("recordManualMatch: keys are lowercased so Transmission's mixed-case hashString and a parsed .torrent's lowercase infoHash correlate", async () => {
  const path = await scratchPath();
  recordManualMatch("ABC123", "Race/stage1.mp4", "/library/pick.mp4", path);
  assert.deepEqual(getManualMatches("abc123", path), { "Race/stage1.mp4": "/library/pick.mp4" });
});

test("recordManualMatch: multiple files for the same torrent accumulate rather than overwrite each other", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/one.mp4", path);
  recordManualMatch("abc123", "Race/stage2.mp4", "/library/two.mp4", path);
  assert.deepEqual(getManualMatches("abc123", path), {
    "Race/stage1.mp4": "/library/one.mp4",
    "Race/stage2.mp4": "/library/two.mp4",
  });
});

test("recordManualMatch: recording again for the same file overwrites the old pick", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/old-pick.mp4", path);
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/new-pick.mp4", path);
  assert.deepEqual(getManualMatches("abc123", path), { "Race/stage1.mp4": "/library/new-pick.mp4" });
});

test("getManualMatches: seeds a missing file rather than crashing (first-boot bind-mount case)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "domestique-match-overrides-"));
  const path = join(dir, "match-overrides.json"); // deliberately never created

  assert.deepEqual(getManualMatches("anything", path), {});
  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk, {});
});

test("clearManualMatch: removes only the one file's pick, leaving sibling files and other torrents untouched", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/one.mp4", path);
  recordManualMatch("abc123", "Race/stage2.mp4", "/library/two.mp4", path);
  recordManualMatch("xyz789", "Other/stage1.mp4", "/library/other.mp4", path);

  clearManualMatch("abc123", "Race/stage1.mp4", path);

  assert.deepEqual(getManualMatches("abc123", path), { "Race/stage2.mp4": "/library/two.mp4" });
  assert.deepEqual(getManualMatches("xyz789", path), { "Other/stage1.mp4": "/library/other.mp4" });
});

test("clearManualMatch: clearing the last file for a torrent removes the now-empty torrent entry entirely", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/one.mp4", path);
  clearManualMatch("abc123", "Race/stage1.mp4", path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.equal("abc123" in onDisk, false);
});

test("clearManualMatch: clearing a file with no recorded pick is a harmless no-op", async () => {
  const path = await scratchPath();
  clearManualMatch("never-recorded", "Race/stage1.mp4", path);
  assert.deepEqual(getManualMatches("never-recorded", path), {});
});

test("recordManualMatch: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordManualMatch("abc123", "Race/stage1.mp4", "/library/pick.mp4", path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.deepEqual(onDisk["abc123"], { "Race/stage1.mp4": "/library/pick.mp4" });
});
