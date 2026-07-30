import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, link, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStorageStatus, findOrphanOriginal, computePercentComplete } from "../src/seeding.js";
import { recordDedupeOriginal } from "../src/dedupeState.js";
import type { ReseedPlan } from "../src/reseedMatch.js";

function matchedPlan(torrentName: string, files: Array<{ relativePath: string; length: number; candidate: string }>): ReseedPlan {
  return {
    torrentName,
    files: files.map((f) => ({ relativePath: f.relativePath, length: f.length, status: "matched", candidate: f.candidate })),
    matchedCount: files.length,
    ambiguousCount: 0,
    unmatchedCount: 0,
  };
}

test("computePercentComplete: sums bytesCompleted/length across every file regardless of wanted state", () => {
  assert.equal(computePercentComplete([{ length: 1000, bytesCompleted: 0 }]), 0);
  assert.equal(
    computePercentComplete([
      { length: 1000, bytesCompleted: 1000 },
      { length: 1000, bytesCompleted: 0 },
    ]),
    0.5
  );
  assert.equal(computePercentComplete([{ length: 1000, bytesCompleted: 1000 }]), 1);
});

test("computePercentComplete: zero total length returns 0 rather than dividing by zero", () => {
  assert.equal(computePercentComplete([]), 0);
});

test("computeStorageStatus: 'deduped' when the on-disk file and its matched library candidate are the same inode (a real hardlink)", async () => {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-lib-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "domestique-seeding-dl-"));
  try {
    const libFile = join(libraryRoot, "Deduped - S2026E01.mp4");
    await writeFile(libFile, Buffer.alloc(1000));
    await link(libFile, join(downloadDir, "Deduped.mp4"));

    const plan = matchedPlan("Deduped.mp4", [{ relativePath: "Deduped.mp4", length: 1000, candidate: libFile }]);
    assert.equal(await computeStorageStatus(plan, downloadDir), "deduped");
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("computeStorageStatus: 'duplicate' when the on-disk file is a separate file from its matched candidate, same size or not", async () => {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-lib-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "domestique-seeding-dl-"));
  try {
    const libFile = join(libraryRoot, "Duplicate - S2026E01.mp4");
    await writeFile(libFile, Buffer.alloc(2000));
    await writeFile(join(downloadDir, "Duplicate.mp4"), Buffer.alloc(2000));

    const plan = matchedPlan("Duplicate.mp4", [{ relativePath: "Duplicate.mp4", length: 2000, candidate: libFile }]);
    assert.equal(await computeStorageStatus(plan, downloadDir), "duplicate");
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("computeStorageStatus: 'mixed' for a multi-file torrent where only some files are hardlinked", async () => {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-lib-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "domestique-seeding-dl-"));
  try {
    const libA = join(libraryRoot, "Mixed A - S2026E01.mp4");
    const libB = join(libraryRoot, "Mixed B - S2026E01.mp4");
    await writeFile(libA, Buffer.alloc(3000));
    await writeFile(libB, Buffer.alloc(4000));
    await mkdir(join(downloadDir, "Mixed Torrent"), { recursive: true });
    await link(libA, join(downloadDir, "Mixed Torrent", "a.mp4"));
    await writeFile(join(downloadDir, "Mixed Torrent", "b.mp4"), Buffer.alloc(4000));

    const plan = matchedPlan("Mixed Torrent", [
      { relativePath: "Mixed Torrent/a.mp4", length: 3000, candidate: libA },
      { relativePath: "Mixed Torrent/b.mp4", length: 4000, candidate: libB },
    ]);
    assert.equal(await computeStorageStatus(plan, downloadDir), "mixed");
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("computeStorageStatus: 'n/a' when the plan isn't a full, unambiguous match", async () => {
  const downloadDir = await mkdtemp(join(tmpdir(), "domestique-seeding-dl-"));
  try {
    const plan: ReseedPlan = {
      torrentName: "Partial",
      files: [{ relativePath: "a.mp4", length: 1000, status: "unmatched" }],
      matchedCount: 0,
      ambiguousCount: 0,
      unmatchedCount: 1,
    };
    assert.equal(await computeStorageStatus(plan, downloadDir), "n/a");
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("computeStorageStatus: a file that can't be stat'd (missing from downloadDir) is conservatively treated as NOT deduped", async () => {
  const libraryRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-lib-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "domestique-seeding-dl-"));
  try {
    const libFile = join(libraryRoot, "Missing - S2026E01.mp4");
    await writeFile(libFile, Buffer.alloc(500));
    // Deliberately nothing written at downloadDir/Missing.mp4.
    const plan = matchedPlan("Missing.mp4", [{ relativePath: "Missing.mp4", length: 500, candidate: libFile }]);
    assert.equal(await computeStorageStatus(plan, downloadDir), "duplicate");
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test(
  "findOrphanOriginal flags a leftover only from a recorded dedupeState entry, never by guessing a path - reproduces the real bug (Transmission's actual downloadDir is a subfolder of DOWNLOADS_PATH, e.g. /downloads/complete)",
  async () => {
    const downloadsRoot = await mkdtemp(join(tmpdir(), "domestique-seeding-downloads-")); // stands in for DOWNLOADS_PATH, e.g. "/downloads"
    const completeDir = join(downloadsRoot, "complete"); // Transmission's REAL downloadDir - a subfolder, not DOWNLOADS_PATH itself
    const outsideDir = await mkdtemp(join(tmpdir(), "domestique-seeding-outside-"));
    const dedupeStatePath = join(downloadsRoot, "dedupe-state.json");
    await mkdir(completeDir, { recursive: true });
    try {
      // Case 1: recorded original points at completeDir (the real per-torrent
      // downloadDir, NOT downloadsRoot itself), and the file is still
      // genuinely there at the exact expected size - should be flagged. This
      // is exactly the real "Highlights"/`/downloads/complete` bug shape.
      await writeFile(join(completeDir, "Orphan-Present.mp4"), Buffer.alloc(2000));
      recordDedupeOriginal("Orphan-Present.mp4", { dir: completeDir, name: "Orphan-Present.mp4" }, dedupeStatePath);
      const plan1 = matchedPlan("Orphan-Present.mp4", [
        { relativePath: "Orphan-Present.mp4", length: 2000, candidate: "/irrelevant" },
      ]);
      assert.deepEqual(await findOrphanOriginal(plan1, downloadsRoot, dedupeStatePath), {
        dir: completeDir,
        name: "Orphan-Present.mp4",
        totalBytes: 2000,
      });

      // Case 2: a recorded original exists, but the file itself was already
      // deleted (the normal, successful end state) - nothing at that path
      // anymore. Should NOT be flagged.
      recordDedupeOriginal("Already-Cleaned.mp4", { dir: completeDir, name: "Already-Cleaned.mp4" }, dedupeStatePath);
      const plan2 = matchedPlan("Already-Cleaned.mp4", [
        { relativePath: "Already-Cleaned.mp4", length: 1500, candidate: "/irrelevant" },
      ]);
      assert.equal(await findOrphanOriginal(plan2, downloadsRoot, dedupeStatePath), null);

      // Case 3: recorded original exists, but the file sitting there is a
      // different size (already edited/replaced by something else) - a
      // partial/ambiguous leftover, deliberately NOT flagged.
      await writeFile(join(completeDir, "Resized-Leftover.mp4"), Buffer.alloc(999));
      recordDedupeOriginal("Resized-Leftover.mp4", { dir: completeDir, name: "Resized-Leftover.mp4" }, dedupeStatePath);
      const plan3 = matchedPlan("Resized-Leftover.mp4", [
        { relativePath: "Resized-Leftover.mp4", length: 3000, candidate: "/irrelevant" },
      ]);
      assert.equal(await findOrphanOriginal(plan3, downloadsRoot, dedupeStatePath), null);

      // Case 4: NO recorded original at all (never went through this app's
      // dedupe) - even though a coincidental same-name, same-size file
      // happens to sit directly under downloadsRoot. Proves the fix doesn't
      // fall back to guessing downloadsPath directly (the actual old bug).
      await writeFile(join(downloadsRoot, "Never-Deduped-Coincidence.mp4"), Buffer.alloc(1234));
      const plan4 = matchedPlan("Never-Deduped-Coincidence.mp4", [
        { relativePath: "Never-Deduped-Coincidence.mp4", length: 1234, candidate: "/irrelevant" },
      ]);
      assert.equal(await findOrphanOriginal(plan4, downloadsRoot, dedupeStatePath), null);

      // Case 5: recorded original's dir is OUTSIDE downloadsRoot entirely
      // (defensive sanity check) - rejected even though the file genuinely
      // exists there at the right size.
      await writeFile(join(outsideDir, "Outside-Sanity-Check.mp4"), Buffer.alloc(4321));
      recordDedupeOriginal(
        "Outside-Sanity-Check.mp4",
        { dir: outsideDir, name: "Outside-Sanity-Check.mp4" },
        dedupeStatePath
      );
      const plan5 = matchedPlan("Outside-Sanity-Check.mp4", [
        { relativePath: "Outside-Sanity-Check.mp4", length: 4321, candidate: "/irrelevant" },
      ]);
      assert.equal(await findOrphanOriginal(plan5, downloadsRoot, dedupeStatePath), null);
    } finally {
      await rm(downloadsRoot, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  }
);
