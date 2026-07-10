import { test } from "node:test";
import assert from "node:assert/strict";
import { recordActivity, getRecentActivity, type ActivityEvent } from "../src/activity.js";

function makeEvent(torrentName: string): ActivityEvent {
  return { timestamp: new Date().toISOString(), torrentName, lines: [`✅ ${torrentName}`], reviewWorthy: false };
}

test("recordActivity: newest event is first", () => {
  const before = getRecentActivity().length;
  recordActivity(makeEvent("first"));
  recordActivity(makeEvent("second"));
  const events = getRecentActivity();
  assert.equal(events.length, before + 2);
  assert.equal(events[0].torrentName, "second");
  assert.equal(events[1].torrentName, "first");
});

test("recordActivity: caps at 100 events, evicting the oldest", () => {
  for (let i = 0; i < 150; i++) {
    recordActivity(makeEvent(`bulk-${i}`));
  }
  const events = getRecentActivity();
  assert.equal(events.length, 100);
  assert.equal(events[0].torrentName, "bulk-149");
  assert.equal(events[99].torrentName, "bulk-50");
});
