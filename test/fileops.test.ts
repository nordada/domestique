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
    720
  );
  assertCopied(out1);

  const part2 = await makeSourceFile(sourceDir, "pt02.mp4");
  const out2 = await copyIntoLibrary(
    part2,
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt02.mp4",
    1,
    720
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

  await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, 720);
  const second = await copyIntoLibrary(src, libraryRoot, destDir, "TestShow - S2026E01.mp4", 1, 720);

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
    720
  );

  // Different release shape (no part suffix) for the same episode, so it
  // doesn't collide on destPath and actually reaches the resolution check.
  const lowRes = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "lo.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    480
  );

  assertSkipped(lowRes);
  assert.match(lowRes.reason, /lower resolution/);
});

test("quality-aware copy: higher-resolution re-release is filed alongside with a REVIEW suffix, not deleted/overwritten", async () => {
  const { libraryRoot, sourceDir } = await makeScratch();
  const destDir = "TestShow/Season 2026";

  await copyIntoLibrary(
    await makeSourceFile(sourceDir, "hi.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720
  );

  const upgrade = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "better.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1.mp4",
    1,
    1080
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
    null
  );

  const second = await copyIntoLibrary(
    await makeSourceFile(sourceDir, "b.mp4"),
    libraryRoot,
    destDir,
    "TestShow - S2026E01 - Stage 1 - pt01.mp4",
    1,
    720
  );

  assertCopied(second);
  assert.equal(second.warning, undefined);
});
