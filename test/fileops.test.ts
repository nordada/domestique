import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIntoLibrary, type CopyOutcome } from "../src/fileops.js";

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

  // Original 720p file must still be there — nothing auto-deleted.
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
