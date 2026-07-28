import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageMatchedFiles } from "../src/reseedStage.js";
import type { ReseedPlan } from "../src/reseedMatch.js";

async function makeScratch(): Promise<{ libraryDir: string; stagingDir: string }> {
  const libraryDir = await mkdtemp(join(tmpdir(), "domestique-stage-library-"));
  const stagingDir = await mkdtemp(join(tmpdir(), "domestique-stage-out-"));
  return { libraryDir, stagingDir };
}

test("stageMatchedFiles hardlinks a matched file into the exact expected relative layout", async () => {
  const { libraryDir, stagingDir } = await makeScratch();
  try {
    const candidate = join(libraryDir, "Stage 1.mp4");
    await writeFile(candidate, "race footage");

    const plan: ReseedPlan = {
      torrentName: "Race",
      matchedCount: 1,
      ambiguousCount: 0,
      unmatchedCount: 0,
      files: [{ relativePath: "Race/stage1.mp4", length: 12, status: "matched", candidate }],
    };

    const results = await stageMatchedFiles(plan, stagingDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].method, "hardlink");

    const destPath = join(stagingDir, "Race", "stage1.mp4");
    assert.equal(results[0].destPath, destPath);
    const [srcStat, destStat] = await Promise.all([stat(candidate), stat(destPath)]);
    assert.equal(srcStat.ino, destStat.ino, "staged file should be the same inode as the library file");
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("stageMatchedFiles falls back to a byte-identical copy when hardlinking reports EXDEV", async () => {
  const { libraryDir, stagingDir } = await makeScratch();
  try {
    const candidate = join(libraryDir, "Stage 1.mp4");
    await writeFile(candidate, "race footage");

    const plan: ReseedPlan = {
      torrentName: "Race",
      matchedCount: 1,
      ambiguousCount: 0,
      unmatchedCount: 0,
      files: [{ relativePath: "Race/stage1.mp4", length: 12, status: "matched", candidate }],
    };

    const alwaysExdev = async () => {
      const err = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    };

    const results = await stageMatchedFiles(plan, stagingDir, { link: alwaysExdev as never });
    assert.equal(results[0].method, "copy");
    const destContent = await readFile(join(stagingDir, "Race", "stage1.mp4"), "utf-8");
    assert.equal(destContent, "race footage");
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("stageMatchedFiles writes an empty file for a zero-length match, with no candidate needed", async () => {
  const { stagingDir } = await makeScratch();
  try {
    const plan: ReseedPlan = {
      torrentName: "Race",
      matchedCount: 1,
      ambiguousCount: 0,
      unmatchedCount: 0,
      files: [{ relativePath: "Race/readme.nfo", length: 0, status: "matched" }],
    };
    const results = await stageMatchedFiles(plan, stagingDir);
    assert.equal(results[0].method, "empty");
    const content = await readFile(join(stagingDir, "Race", "readme.nfo"));
    assert.equal(content.length, 0);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("stageMatchedFiles never creates anything for ambiguous or unmatched entries", async () => {
  const { stagingDir } = await makeScratch();
  try {
    const plan: ReseedPlan = {
      torrentName: "Race",
      matchedCount: 0,
      ambiguousCount: 1,
      unmatchedCount: 1,
      files: [
        { relativePath: "Race/ambiguous.mp4", length: 10, status: "ambiguous", candidates: ["/a", "/b"] },
        { relativePath: "Race/unmatched.mp4", length: 20, status: "unmatched" },
      ],
    };
    const results = await stageMatchedFiles(plan, stagingDir);
    assert.equal(results.length, 0);
    await assert.rejects(() => stat(join(stagingDir, "Race", "ambiguous.mp4")));
    await assert.rejects(() => stat(join(stagingDir, "Race", "unmatched.mp4")));
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("stageMatchedFiles clears a stale leftover from a previous attempt before re-staging", async () => {
  const { libraryDir, stagingDir } = await makeScratch();
  try {
    const candidate = join(libraryDir, "Stage 1.mp4");
    await writeFile(candidate, "new content");

    const stalePath = join(stagingDir, "Race", "stage1.mp4");
    await mkdir(join(stagingDir, "Race"), { recursive: true });
    await writeFile(stalePath, "stale leftover content that should be replaced");

    const plan: ReseedPlan = {
      torrentName: "Race",
      matchedCount: 1,
      ambiguousCount: 0,
      unmatchedCount: 0,
      files: [{ relativePath: "Race/stage1.mp4", length: 11, status: "matched", candidate }],
    };
    await stageMatchedFiles(plan, stagingDir);
    const content = await readFile(stalePath, "utf-8");
    assert.equal(content, "new content");
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
});
