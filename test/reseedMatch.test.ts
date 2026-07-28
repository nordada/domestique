import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReseedPlan } from "../src/reseedMatch.js";
import type { TorrentMetainfo } from "../src/torrentFile.js";

test("buildReseedPlan matches a file with exactly one same-size library candidate", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/Race/Stage 1.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.matchedCount, 1);
  assert.deepEqual(plan.files[0], {
    relativePath: "Race/stage1.mp4",
    length: 100,
    status: "matched",
    candidate: "/library/Race/Stage 1.mp4",
  });
});

test("buildReseedPlan flags a file with multiple same-size candidates as ambiguous, never guessing", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/a.mp4", "/library/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.ambiguousCount, 1);
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.files[0].status, "ambiguous");
  assert.deepEqual(plan.files[0].candidates, ["/library/a.mp4", "/library/b.mp4"]);
  assert.equal(plan.files[0].candidate, undefined);
});

test("buildReseedPlan reports a file with no size match as unmatched", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 999 }] };
  const plan = buildReseedPlan(meta, new Map());
  assert.equal(plan.unmatchedCount, 1);
  assert.equal(plan.files[0].status, "unmatched");
});

test("buildReseedPlan auto-matches zero-length files without a candidate search", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/empty.nfo", length: 0 }] };
  const plan = buildReseedPlan(meta, new Map());
  assert.equal(plan.matchedCount, 1);
  assert.deepEqual(plan.files[0], { relativePath: "Race/empty.nfo", length: 0, status: "matched" });
});

test("buildReseedPlan caps the reported ambiguous candidate list", () => {
  const many = Array.from({ length: 40 }, (_, i) => `/library/dup${i}.mp4`);
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const plan = buildReseedPlan(meta, new Map([[100, many]]));
  assert.equal(plan.files[0].candidates?.length, 25);
});

test("buildReseedPlan mixes matched/ambiguous/unmatched across a multi-file torrent and tallies each", () => {
  const meta: TorrentMetainfo = {
    name: "Race",
    files: [
      { relativePath: "Race/stage1.mp4", length: 100 },
      { relativePath: "Race/stage2.mp4", length: 200 },
      { relativePath: "Race/stage3.mp4", length: 300 },
    ],
  };
  const index = new Map([
    [100, ["/library/stage1.mp4"]],
    [200, ["/library/a.mp4", "/library/b.mp4"]],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.ambiguousCount, 1);
  assert.equal(plan.unmatchedCount, 1);
});
