import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity, getRecentActivity, markActivityRead, type ActivityEvent } from "../src/activity.js";

async function scratchPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "bra-activity-"));
  return join(dir, "activity.json");
}

function makeEvent(torrentName: string): Omit<ActivityEvent, "id" | "read"> {
  return { timestamp: new Date().toISOString(), torrentName, lines: [`✅ ${torrentName}`], reviewWorthy: false };
}

test("recordActivity: newest event is first", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("first"), path);
  recordActivity(makeEvent("second"), path);
  const events = getRecentActivity(path);
  assert.equal(events.length, 2);
  assert.equal(events[0].torrentName, "second");
  assert.equal(events[1].torrentName, "first");
});

test("recordActivity: caps at 100 events, evicting the oldest", async () => {
  const path = await scratchPath();
  for (let i = 0; i < 150; i++) {
    recordActivity(makeEvent(`bulk-${i}`), path);
  }
  const events = getRecentActivity(path);
  assert.equal(events.length, 100);
  assert.equal(events[0].torrentName, "bulk-149");
  assert.equal(events[99].torrentName, "bulk-50");
});

test("recordActivity: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("one"), path);
  recordActivity(makeEvent("two"), path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[0].torrentName, "two");
  assert.equal(onDisk[1].torrentName, "one");
});

test("getRecentActivity: rehydrates from an already-persisted file on first access - what a restart looks like", async () => {
  const path = await scratchPath();
  // Written directly to disk, never through recordActivity - simulates
  // what's already there from a previous process's lifetime, before this
  // (fresh) process has ever touched this path.
  const seeded: ActivityEvent[] = [makeEvent("from-before-restart")];
  await fs.writeFile(path, JSON.stringify(seeded), "utf-8");

  const events = getRecentActivity(path);
  assert.equal(events.length, 1);
  assert.equal(events[0].torrentName, "from-before-restart");
});

test("recordActivity: seeds a missing file rather than crashing (first-boot bind-mount case)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "bra-activity-"));
  const path = join(dir, "activity.json"); // deliberately never created

  recordActivity(makeEvent("first-ever"), path);
  const events = getRecentActivity(path);
  assert.equal(events.length, 1);
  assert.equal(events[0].torrentName, "first-ever");
});

test("recordActivity: assigns a unique id and starts every event unread", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("one"), path);
  recordActivity(makeEvent("two"), path);
  const events = getRecentActivity(path);
  assert.equal(events[0].read, false);
  assert.equal(events[1].read, false);
  assert.ok(events[0].id);
  assert.ok(events[1].id);
  assert.notEqual(events[0].id, events[1].id);
});

test("markActivityRead: marks specific ids read without touching others", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("one"), path);
  recordActivity(makeEvent("two"), path);
  recordActivity(makeEvent("three"), path);
  const [three, two, one] = getRecentActivity(path);

  markActivityRead([two.id], path);

  const after = getRecentActivity(path);
  assert.equal(after.find((e) => e.id === one.id)?.read, false);
  assert.equal(after.find((e) => e.id === two.id)?.read, true);
  assert.equal(after.find((e) => e.id === three.id)?.read, false);
});

test("markActivityRead: \"all\" marks every event read in one call, keeping them (not deleting)", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("one"), path);
  recordActivity(makeEvent("two"), path);

  markActivityRead("all", path);

  const events = getRecentActivity(path);
  assert.equal(events.length, 2); // still present - "clear" hides, never deletes
  assert.ok(events.every((e) => e.read === true));
});

test("markActivityRead: persists to disk, not just in-memory", async () => {
  const path = await scratchPath();
  recordActivity(makeEvent("one"), path);
  const [event] = getRecentActivity(path);
  markActivityRead([event.id], path);

  const onDisk = JSON.parse(await fs.readFile(path, "utf-8"));
  assert.equal(onDisk[0].read, true);
});
