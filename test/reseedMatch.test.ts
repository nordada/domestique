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
  const index = new Map([[100, ["/library/Race/a.mp4", "/library/Race/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.ambiguousCount, 1);
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.guessedCount, 0);
  assert.equal(plan.files[0].status, "ambiguous");
  assert.deepEqual(new Set(plan.files[0].candidates), new Set(["/library/Race/a.mp4", "/library/Race/b.mp4"]));
  assert.equal(plan.files[0].candidate, undefined);
});

test("buildReseedPlan excludes a same-size candidate that shares no race-identity word with the torrent, rather than leaving it ambiguous", () => {
  // The real incident this fixed: a "1986 Tour De France DVD3" torrent's
  // VTS_01_N.VOB files (raw DVD-rip parts, ~1GB each per the DVD-Video
  // spec's VOB size cap) kept surfacing a same-size Giro d'Italia library
  // file as an "ambiguous, pick one" candidate purely on byte-size
  // coincidence - nothing about a Giro d'Italia file is plausibly this Tour
  // de France torrent, so it should be excluded outright, not offered.
  // Two same-size Giro candidates (not one) so this exercises the same
  // "ambiguous, pick one" code path the real incident hit - a single
  // same-size candidate is always trusted outright, by a separate,
  // deliberate existing design tradeoff this fix doesn't touch.
  const meta: TorrentMetainfo = {
    name: "1986 Tour De France DVD3",
    files: [{ relativePath: "1986 Tour De France DVD3/VIDEO_TS/VTS_01_1.VOB", length: 1_073_741_824 }],
  };
  const index = new Map([
    [
      1_073_741_824,
      [
        "/library/Giro D'Italia/Season 1986/Giro D'Italia - S1986E01 - pt01.vob",
        "/library/Giro D'Italia/Season 1986/Giro D'Italia - S1986E01 - pt02.vob",
      ],
    ],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files[0].status, "unmatched");
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.ambiguousCount, 0);
  assert.equal(plan.unmatchedCount, 1);
});

test("buildReseedPlan keeps a same-race same-size candidate ambiguous even when a same-size different-race candidate is also present", () => {
  const meta: TorrentMetainfo = {
    name: "1986 Tour De France DVD3",
    files: [{ relativePath: "1986 Tour De France DVD3/VIDEO_TS/VTS_01_1.VOB", length: 1_073_741_824 }],
  };
  const index = new Map([
    [
      1_073_741_824,
      [
        "/library/Giro D'Italia/Season 1986/Giro D'Italia - S1986E01 - pt01.vob",
        "/library/Tour De France/Season 1986/Tour De France - S1986E01 - pt02.vob",
      ],
    ],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files[0].status, "ambiguous");
  assert.deepEqual(plan.files[0].candidates, [
    "/library/Tour De France/Season 1986/Tour De France - S1986E01 - pt02.vob",
  ]);
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
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/empty.mp4", length: 0 }] };
  const plan = buildReseedPlan(meta, new Map());
  assert.equal(plan.matchedCount, 1);
  assert.deepEqual(plan.files[0], { relativePath: "Race/empty.mp4", length: 0, status: "matched" });
});

test("buildReseedPlan caps the reported ambiguous candidate list", () => {
  const many = Array.from({ length: 40 }, (_, i) => `/library/Race/dup${i}.mp4`);
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
    [100, ["/library/Race/stage1.mp4"]],
    [200, ["/library/Race/a.mp4", "/library/Race/b.mp4"]],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.ambiguousCount, 1);
  assert.equal(plan.unmatchedCount, 1);
});

test("buildReseedPlan excludes DVD navigation files (.IFO/.BUP/VIDEO_TS.VOB) from both the file list and the match denominator", () => {
  // The real incident this fixed: a DVD-rip torrent whose 5 real VTS video
  // files were all correctly filed still showed a permanent "Partial match"
  // (5 matched of 10 total) because the torrent's 5 .IFO/.BUP nav files can
  // never be "matched" - fileops.ts never copies them into the library in
  // the first place. That false partial-match, in turn, made the Index
  // tab's "Add to Plex library" bulk action offer itself for an
  // already-fully-filed torrent, and clicking it force-copied duplicates.
  const meta: TorrentMetainfo = {
    name: "1985 Giro d'Italia",
    files: [
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VTS_01_1.VOB", length: 100 },
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VTS_01_0.IFO", length: 10 },
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VTS_01_0.BUP", length: 10 },
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VIDEO_TS.VOB", length: 5 },
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VIDEO_TS.IFO", length: 5 },
      { relativePath: "1985 Giro d'Italia/VIDEO_TS/VIDEO_TS.BUP", length: 5 },
    ],
  };
  const index = new Map([[100, ["/library/Giro D'Italia/Season 1985/Giro D'Italia - S1985E01 - pt01.vob"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.matchedCount, plan.files.length);
});

test("buildReseedPlan excludes DVD-recorder housekeeping files (VIDEO_RM.DAT/PVR_TEMP.USR/DVD_REC.USR) from the match denominator", () => {
  // Real incident, found live on the user's own library: "Giro D'Italia
  // History 1909-1993" carries both a VIDEO_TS folder (3 real VTS_01_N.VOB
  // parts, all correctly filed) and a VIDEO_RM folder (recorder metadata
  // from a different disc-authoring convention than VIDEO_TS's own
  // .IFO/.BUP) - the torrent showed a permanent "Partial match: 3/6" purely
  // because those 3 junk files could never match anything in the library.
  const meta: TorrentMetainfo = {
    name: "Giro D'Italia History 1909-1993",
    files: [
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_TS/VTS_01_1.VOB", length: 100 },
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_TS/VTS_01_2.VOB", length: 200 },
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_TS/VTS_01_3.VOB", length: 300 },
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_RM/VIDEO_RM.DAT", length: 10 },
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_RM/PVR_TEMP.USR", length: 20 },
      { relativePath: "Giro D'Italia History 1909-1993/VIDEO_RM/DVD_REC.USR", length: 30 },
    ],
  };
  const index = new Map([
    [100, ["/library/Giro D'Italia History/Giro D'Italia History - S1993E01 - pt01.vob"]],
    [200, ["/library/Giro D'Italia History/Giro D'Italia History - S1993E01 - pt02.vob"]],
    [300, ["/library/Giro D'Italia History/Giro D'Italia History - S1993E01 - pt03.vob"]],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files.length, 3);
  assert.equal(plan.matchedCount, 3);
  assert.equal(plan.matchedCount, plan.files.length);
});

test("buildReseedPlan excludes generic non-video companion files (.ssp/.nfo/etc) from the match denominator", () => {
  // Real incident, found live: "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2"
  // carries a stray "Project-2.ssp" (a video-editing project file) alongside
  // its 2 real, already-filed video parts - showed a permanent "Partial
  // match: 2/3" purely because that one file could never match anything in
  // a Plex library (which never stores non-video files at all).
  const meta: TorrentMetainfo = {
    name: "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2",
    files: [
      { relativePath: "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2/TdF-2019-Stage-17-(ESHD)-Part-3-of-4.mp4", length: 100 },
      { relativePath: "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2/TdF-2019-Stage-17-(ESHD)-Part-4-of-4.mp4", length: 200 },
      { relativePath: "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2/Project-2.ssp", length: 10 },
    ],
  };
  const index = new Map([
    [100, ["/library/Tour de France/TdF - S2019E17 - pt03.mp4"]],
    [200, ["/library/Tour de France/TdF - S2019E17 - pt04.mp4"]],
  ]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files.length, 2);
  assert.equal(plan.matchedCount, 2);
  assert.equal(plan.matchedCount, plan.files.length);
});

test("applyManualOverrides promotes an ambiguous file to matched when a recorded pick is one of its own candidates", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/Race/a.mp4", "/library/Race/b.mp4"]]]);
  const plan = buildReseedPlan(meta, index);
  assert.equal(plan.files[0].status, "ambiguous");

  const resolved = applyManualOverrides(plan, { "Race/stage1.mp4": "/library/Race/b.mp4" });
  assert.equal(resolved.matchedCount, 1);
  assert.equal(resolved.ambiguousCount, 0);
  assert.equal(resolved.guessedCount, 0);
  assert.equal(resolved.files[0].status, "matched");
  assert.equal(resolved.files[0].candidate, "/library/Race/b.mp4");
  assert.equal(resolved.files[0].resolvedBy, "manual");
});

test("applyManualOverrides ignores a stale override whose candidate isn't (or is no longer) among the file's own candidates", () => {
  const meta: TorrentMetainfo = { name: "Race", files: [{ relativePath: "Race/stage1.mp4", length: 100 }] };
  const index = new Map([[100, ["/library/Race/a.mp4", "/library/Race/b.mp4"]]]);
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
