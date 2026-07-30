import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReseedPlan, applyManualOverrides } from "../src/reseedMatch.js";
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

test("buildReseedPlan leaves a file ambiguous when no candidate's filename scores higher than the others", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/a.mp4", "/library/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.ambiguousCount, 1);
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.guessedCount, 0);
  assert.equal(plan.files[0].status, "ambiguous");
  assert.deepEqual(new Set(plan.files[0].candidates), new Set(["/library/a.mp4", "/library/b.mp4"]));
  assert.equal(plan.files[0].candidate, undefined);
});

test("buildReseedPlan auto-guesses among same-size DVD-boxset candidates via disc-number filename scoring", () => {
  // The real case this was built for: an old multi-disc DVD-rip boxset
  // where several discs land on the exact same byte size, and the torrent's
  // own name carries the one signal (its own disc number) that tells them
  // apart - see parser.ts's disc/cd/dvd regex and reseedMatch.ts's
  // scoreCandidate.
  const meta: TorrentMetainfo = {
    name: "1986 Tour De France DVD3",
    files: [{ relativePath: "1986 Tour De France DVD3/1986 Tour De France DVD3.avi", length: 4_400_000_000 }],
  };
  const index = new Map([
    [
      4_400_000_000,
      [
        "/library/1986 Tour de France - DVD1.avi",
        "/library/1986 Tour de France - DVD2.avi",
        "/library/1986 Tour de France - DVD3.avi",
        "/library/1986 Tour de France - DVD4.avi",
      ],
    ],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.ambiguousCount, 0);
  assert.equal(plan.guessedCount, 1);
  const file = plan.files[0];
  assert.equal(file.status, "matched");
  assert.equal(file.resolvedBy, "guess");
  assert.equal(file.candidate, "/library/1986 Tour de France - DVD3.avi");
  // Every original candidate is still reported, best guess first, so the UI
  // can show/undo the alternatives rather than hiding them once resolved.
  assert.equal(file.candidates?.[0], "/library/1986 Tour de France - DVD3.avi");
  assert.equal(file.candidates?.length, 4);
});

test("buildReseedPlan does not guess when disc numbers actively conflict but overall names are otherwise identical", () => {
  // Sanity check on the scoring direction: a wrong-disc candidate must not
  // simply score "a bit lower" than the right one - it should be pushed
  // decisively below anything with no stage/part signal at all, and a tie
  // between two WRONG discs must never accidentally win by default.
  const meta: TorrentMetainfo = {
    name: "Race",
    files: [{ relativePath: "Race/Race - Disc 5.mp4", length: 100 }],
  };
  const index = new Map([[100, ["/library/Race - Disc 1.mp4", "/library/Race - Disc 2.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files[0].status, "ambiguous");
  assert.equal(plan.guessedCount, 0);
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

test("applyManualOverrides promotes an ambiguous file to matched when a recorded pick is one of its own candidates", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/a.mp4", "/library/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files[0].status, "ambiguous");

  const resolved = applyManualOverrides(plan, { "Race/stage1.mp4": "/library/b.mp4" });
  assert.equal(resolved.matchedCount, 1);
  assert.equal(resolved.ambiguousCount, 0);
  assert.equal(resolved.guessedCount, 0);
  assert.equal(resolved.files[0].status, "matched");
  assert.equal(resolved.files[0].candidate, "/library/b.mp4");
  assert.equal(resolved.files[0].resolvedBy, "manual");
});

test("applyManualOverrides ignores a stale override whose candidate isn't (or is no longer) among the file's own candidates", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/a.mp4", "/library/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);

  const resolved = applyManualOverrides(plan, { "Race/stage1.mp4": "/library/no-longer-there.mp4" });
  assert.equal(resolved.files[0].status, "ambiguous");
  assert.equal(resolved.matchedCount, 0);
  assert.equal(resolved.ambiguousCount, 1);
});

test("applyManualOverrides is a no-op for a file that's already matched or unmatched, even if an override happens to be recorded for it", () => {
  const meta: TorrentMetainfo = {
    name: "Race",
    files: [
      { relativePath: "Race/stage1.mp4", length: 100 },
      { relativePath: "Race/stage2.mp4", length: 999 },
    ],
  };
  const index = new Map([[100, ["/library/only.mp4"]]]);
  const plan = buildReseedPlan(meta, index);

  const resolved = applyManualOverrides(plan, {
    "Race/stage1.mp4": "/library/something-else.mp4",
    "Race/stage2.mp4": "/library/something-else.mp4",
  });
  assert.deepEqual(resolved, plan);
});
