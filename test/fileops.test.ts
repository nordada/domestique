import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIntoLibrary, isPathWithin, resolveSourceItems, type CopyOutcome } from "../src/fileops.js";

async function makeScratch() {
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "bra-library-"));
  const sourceDir = await fs.mkdtemp(join(tmpdir(), "bra-source-"));
  return { libraryRoot, sourceDir };
}

async function makeSourceFile(sourceDir: string, name: string, contents = "dummy") {
  const path = join(sourceDir, name);
  await fs.writeFile(path, contents);
  return path;
}

function assertCopied(outcome: CopyOutcome): asserts outcome is Extract<CopyOutcome, { status: "copied" }> {
  if (outcome.status !== "copied") {
    assert.fail(`expected "copied", got "${outcome.status}"`);
  }
}

function assertSkipped(outcome: CopyOutcome): asserts outcome is Extract<CopyOutcome, { status: "skipped" }> {
  if (outcome.status !== "skipped") {
    assert.fail(`expected "skipped", got "${outcome.status}"`);
  }
}

test("isPathWithin allows the root itself and real subpaths, rejects siblings and traversal", () => {
  assert.equal(isPathWithin("/downloads", "/downloads"), true);
  assert.equal(isPathWithin("/downloads/complete/race.mp4", "/downloads"), true);
  assert.equal(isPathWithin("/downloads/a/b/c.mp4", "/downloads"), true);

  // A sibling directory that merely shares the same string prefix is the
  // classic bug a naive startsWith(root) check would let through.
  assert.equal(isPathWithin("/downloads-evil/passwd", "/downloads"), false);
  assert.equal(isPathWithin("/etc/passwd", "/downloads"), false);

  // path.join already collapses ".." before isPathWithin ever sees it in
  // production, but it should still reject an escape if handed one raw.
  assert.equal(isPathWithin("/downloads/../etc/passwd", "/downloads"), false);
  assert.equal(isPathWithin("/downloads/../../etc/passwd", "/downloads"), false);
});

test("resolveSourceItems skips raw DVD navigation files (.BUP/.IFO, VIDEO_TS.VOB) entirely, real video (VTS_NN_MM.VOB) still comes through", async () => {
  // Real incident: a dropped DVD-rip folder's VIDEO_TS.BUP/.IFO got treated
  // as real content and auto-created their own bogus show ("...video-ts")
  // instead of being recognized as non-video DVD navigation metadata.
  const { sourceDir } = await makeScratch();
  const folder = join(sourceDir, "Giro di Italia 1993");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(join(folder, "VIDEO_TS.BUP"), "x");
  await fs.writeFile(join(folder, "VIDEO_TS.IFO"), "x");
  await fs.writeFile(join(folder, "VIDEO_TS.VOB"), "x");
  await fs.writeFile(join(folder, "VTS_01_0.BUP"), "x");
  await fs.writeFile(join(folder, "VTS_01_0.IFO"), "x");
  await fs.writeFile(join(folder, "VTS_01_1.VOB"), "real video 1");
  await fs.writeFile(join(folder, "VTS_01_2.VOB"), "real video 2");

  const items = await resolveSourceItems(sourceDir, "Giro di Italia 1993");
  assert.equal(items.length, 2, "only the two real VOB segments should come through");
  const names = items.map((i) => i.sourceFile.split("/").pop()).sort();
  assert.deepEqual(names, ["VTS_01_1.VOB", "VTS_01_2.VOB"]);
  assert.equal(items.find((i) => i.sourceFile.endsWith("VTS_01_1.VOB"))?.parsed.partNum, 1);
  assert.equal(items.find((i) => i.sourceFile.endsWith("VTS_01_2.VOB"))?.parsed.partNum, 2);
});

test("quality-aware copy: multi-part same-resolution files land normally, no review suffix", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  const part1 = await makeSourceFile(sourceDir, "pt01.mp4");
  const out1 = await copyIntoLibrary(
    part1,
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );
  assertCopied(out1);

  const part2 = await makeSourceFile(sourceDir, "pt02.mp4");
  const out2 = await copyIntoLibrary(
    part2,
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt02.mp4",
    1,
    720,
    null
  );
  assertCopied(out2);
  assert.equal(out2.warning, undefined);

  const meta = JSON.parse(
    await fs.readFile(join(libraryRoot, destDir, ".archiver-meta.json"), "utf-8")
  );
  assert.equal(meta.E01.resolution, 720);
});

test("quality-aware copy: exact duplicate destination is skipped", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const src = await makeSourceFile(sourceDir, "a.mp4");

  await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, 720, null);
  const second = await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, 720, null);

  assertSkipped(second);
  assert.match(second.reason, /already exists/);
});

test("force: bypasses the duplicate-destination skip and files a distinctly-tagged copy instead, without touching the original", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const first = await makeSourceFile(sourceDir, "a.mp4", "original bytes");
  const second = await makeSourceFile(sourceDir, "b.mp4", "different bytes, same everything else");

  const firstOutcome = await copyIntoLibrary(first, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null);
  assertCopied(firstOutcome);

  const forced = await copyIntoLibrary(
    second,
    libraryRoot,
    destDir,
    "TestShow - S2026E01.mp4",
    1,
    null,
    null,
    true
  );
  assertCopied(forced);
  assert.notEqual(forced.destPath, firstOutcome.destPath);
  assert.match(forced.destPath, /REVIEW - forced/);
  assert.match(forced.warning ?? "", /forced past an existing file/i);

  // The original is untouched - still there, still its original bytes.
  assert.equal(await fs.readFile(firstOutcome.destPath, "utf-8"), "original bytes");
  assert.equal(await fs.readFile(forced.destPath, "utf-8"), "different bytes, same everything else");
});

test("force: when the plain forced slot is also taken, tries numbered slots (forced 2, forced 3, ...) instead of giving up - the multi-disc-collision case", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const disc1 = await makeSourceFile(sourceDir, "disc1.mp4", "disc 1 bytes");
  const disc2 = await makeSourceFile(sourceDir, "disc2.mp4", "disc 2 bytes");
  const disc3 = await makeSourceFile(sourceDir, "disc3.mp4", "disc 3 bytes");

  // All three "discs" parse to the same identity in real life (no "disc N"
  // differentiator recognized), so all three ask for the exact same
  // destination - exactly the Giro-2005-style collision this fix is for.
  const first = await copyIntoLibrary(disc1, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null);
  assertCopied(first);

  const forcedTwice = await copyIntoLibrary(disc2, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null, true);
  assertCopied(forcedTwice);
  assert.match(forcedTwice.destPath, /REVIEW - forced\.mp4$/);

  const forcedThrice = await copyIntoLibrary(disc3, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null, true);
  assertCopied(forcedThrice);
  assert.match(forcedThrice.destPath, /REVIEW - forced 2\.mp4$/);

  // All three coexist, each with its own real bytes - none clobbered another.
  assert.equal(await fs.readFile(first.destPath, "utf-8"), "disc 1 bytes");
  assert.equal(await fs.readFile(forcedTwice.destPath, "utf-8"), "disc 2 bytes");
  assert.equal(await fs.readFile(forcedThrice.destPath, "utf-8"), "disc 3 bytes");
});

test("force: still refuses to overwrite anything once every numbered forced slot up to the cap is also taken", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const src = await makeSourceFile(sourceDir, "a.mp4");

  await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null);
  // Pre-occupy the plain forced slot and every numbered one up to the cap
  // (20), so even the exhaustive retry has nowhere left to go.
  await fs.writeFile(join(libraryRoot, destDir, "TestShow - S2026E01 - REVIEW - forced.mp4"), "slot 1");
  for (let i = 2; i <= 20; i++) {
    await fs.writeFile(join(libraryRoot, destDir, `TestShow - S2026E01 - REVIEW - forced ${i}.mp4`), `slot ${i}`);
  }

  const result = await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, null, null, true);
  assertSkipped(result);
  assert.match(result.reason, /already exists/);
  // Confirms nothing already there got overwritten.
  assert.equal(
    await fs.readFile(join(libraryRoot, destDir, "TestShow - S2026E01 - REVIEW - forced.mp4"), "utf-8"),
    "slot 1"
  );
});

test("force: does NOT bypass the lower-resolution skip - only the plain duplicate-destination one", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "hi.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );

  const lowRes = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "lo.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    480,
    null,
    true
  );

  assertSkipped(lowRes);
  assert.match(lowRes.reason, /lower resolution/);
});

test("quality-aware copy: lower-resolution re-release for an archived episode is skipped", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "hi.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );

  // Different release shape (no part suffix) for the same episode, so it
  // doesn't collide on destPath and actually reaches the resolution check.
  const lowRes = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "lo.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    480,
    null
  );

  assertSkipped(lowRes);
  assert.match(lowRes.reason, /lower resolution/);
});

test("quality-aware copy: higher-resolution re-release is filed alongside with a REVIEW tag, not deleted/overwritten", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "hi.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );

  const upgrade = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "better.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    1080,
    null
  );

  assertCopied(upgrade);
  assert.match(upgrade.destPath, /REVIEW - possible 1080p upgrade/);
  assert.match(upgrade.warning ?? "", /existing archive is 720p/);

  // Original 720p file must still be there - nothing auto-deleted.
  const original = await fs.stat(
    join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1 - pt01.mp4")
  );
  assert.ok(original.isFile());

  // Meta keeps the original 720p baseline (not bumped to 1080), so any
  // further arrivals keep getting flagged for review until a human cleans up.
  const meta = JSON.parse(
    await fs.readFile(join(libraryRoot, destDir, ".archiver-meta.json"), "utf-8")
  );
  assert.equal(meta.E01.resolution, 720);
});

test("quality-aware copy: unknown resolution on either side copies normally", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "a.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    null,
    null
  );

  const second = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "b.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );

  assertCopied(second);
  assert.equal(second.warning, undefined);
});

test("alternate versions: same broadcaster's next part lands clean, no tag", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "pt01.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    "Eurosport"
  );

  const part2 = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "pt02.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt02.mp4",
    1,
    720,
    "Eurosport"
  );

  assertCopied(part2);
  assert.equal(part2.destPath, join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1 - pt02.mp4"));
  assert.equal(part2.warning, undefined);
});

test("alternate versions: a different broadcaster at the same resolution is filed as a tagged alternate", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "sbs.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    720,
    "SBS"
  );

  // Different release shape so it doesn't collide on the exact destPath and
  // actually reaches the broadcaster comparison.
  const alt = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "euro.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    "Eurosport"
  );

  assertCopied(alt);
  assert.equal(
    alt.destPath,
    join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1 - Eurosport - pt01.mp4")
  );
  assert.match(alt.warning ?? "", /alternate version \(Eurosport\)/);
  assert.match(alt.warning ?? "", /existing SBS version/);

  // Original SBS file must still be there.
  const original = await fs.stat(
    join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1.mp4")
  );
  assert.ok(original.isFile());

  const meta = JSON.parse(
    await fs.readFile(join(libraryRoot, destDir, ".archiver-meta.json"), "utf-8")
  );
  assert.deepEqual(meta.E01.broadcasters, ["SBS", "Eurosport"]);
});

test("alternate versions: a second part of an already-recognized alternate keeps its own tag, no extra warning", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "sbs-pt01.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    "SBS"
  );
  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "euro-pt01.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    "Eurosport"
  );

  // Eurosport's second part arrives later.
  const euroPart2 = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "euro-pt02.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt02.mp4",
    1,
    720,
    "Eurosport"
  );

  assertCopied(euroPart2);
  assert.equal(
    euroPart2.destPath,
    join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1 - Eurosport - pt02.mp4")
  );
});

test("alternate versions: unknown broadcaster on the new item never creates a tagged alternate", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "sbs.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    720,
    "SBS"
  );

  const unknown = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "plain.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720,
    null
  );

  assertCopied(unknown);
  assert.equal(
    unknown.destPath,
    join(libraryRoot, destDir, "TestShow - S2026E01 - Stage 1 - pt01.mp4")
  );
  assert.equal(unknown.warning, undefined);
});

test("untracked collision: a file placed at the plain path outside Domestique doesn't swallow a later known-broadcaster alternate", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const destDirAbs = join(libraryRoot, destDir);

  // Simulate a file that landed in the library some other way (manual copy,
  // pre-Domestique backfill, etc.) - never went through copyIntoLibrary, so
  // no .archiver-meta.json entry exists for this episode at all.
  await fs.mkdir(destDirAbs, { recursive: true });
  await fs.writeFile(join(destDirAbs, "TestShow - S2026E01 - Stage 1.mp4"), "pre-existing");

  const alt = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "nbc.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    null,
    "NBC"
  );

  assertCopied(alt);
  assert.equal(
    alt.destPath,
    join(destDirAbs, "TestShow - S2026E01 - Stage 1 - NBC.mp4")
  );
  assert.match(alt.warning ?? "", /untracked file already exists/);
  assert.match(alt.warning ?? "", /NBC/);

  // The pre-existing file must be untouched, not overwritten.
  const original = await fs.readFile(join(destDirAbs, "TestShow - S2026E01 - Stage 1.mp4"), "utf-8");
  assert.equal(original, "pre-existing");

  const meta = JSON.parse(await fs.readFile(join(destDirAbs, ".archiver-meta.json"), "utf-8"));
  assert.deepEqual(meta.E01.broadcasters, ["NBC"]);
});

test("untracked collision: with no broadcaster known on the new item either, it's still skipped as a duplicate (nothing to distinguish it by)", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";
  const destDirAbs = join(libraryRoot, destDir);

  await fs.mkdir(destDirAbs, { recursive: true });
  await fs.writeFile(join(destDirAbs, "TestShow - S2026E01 - Stage 1.mp4"), "pre-existing");

  const result = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "plain.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    null,
    null
  );

  assertSkipped(result);
  assert.equal(result.reason, "destination already exists");
});
