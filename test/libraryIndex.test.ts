import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSizeIndex } from "../src/libraryIndex.js";

async function makeScratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "domestique-libindex-"));
}

test("buildSizeIndex buckets files across nested subfolders by exact byte size", async () => {
  const root = await makeScratch();
  try {
    await mkdir(join(root, "Show", "Season 1"), { recursive: true });
    await writeFile(join(root, "Show", "Season 1", "ep1.mp4"), Buffer.alloc(100));
    await writeFile(join(root, "Show", "Season 1", "ep2.mp4"), Buffer.alloc(200));

    const index = await buildSizeIndex(root);
    assert.deepEqual(index.get(100), [join(root, "Show", "Season 1", "ep1.mp4")]);
    assert.deepEqual(index.get(200), [join(root, "Show", "Season 1", "ep2.mp4")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSizeIndex buckets multiple same-size files together (ambiguous-match fodder)", async () => {
  const root = await makeScratch();
  try {
    await writeFile(join(root, "a.mp4"), Buffer.alloc(500));
    await writeFile(join(root, "b.mp4"), Buffer.alloc(500));

    const index = await buildSizeIndex(root);
    const bucket = index.get(500) ?? [];
    assert.equal(bucket.length, 2);
    assert.ok(bucket.includes(join(root, "a.mp4")));
    assert.ok(bucket.includes(join(root, "b.mp4")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSizeIndex never follows symlinks", async () => {
  const root = await makeScratch();
  try {
    await writeFile(join(root, "real.mp4"), Buffer.alloc(300));
    await symlink(join(root, "real.mp4"), join(root, "linked.mp4"));

    const index = await buildSizeIndex(root);
    const bucket = index.get(300) ?? [];
    assert.deepEqual(bucket, [join(root, "real.mp4")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSizeIndex skips a symlinked directory entirely", async () => {
  const root = await makeScratch();
  try {
    await mkdir(join(root, "real-dir"));
    await writeFile(join(root, "real-dir", "inside.mp4"), Buffer.alloc(400));
    await symlink(join(root, "real-dir"), join(root, "linked-dir"));

    const index = await buildSizeIndex(root);
    const bucket = index.get(400) ?? [];
    assert.deepEqual(bucket, [join(root, "real-dir", "inside.mp4")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSizeIndex skips an excluded subdirectory (e.g. the reseed staging dir)", async () => {
  const root = await makeScratch();
  try {
    await mkdir(join(root, ".reseed-staging", "some-torrent"), { recursive: true });
    await writeFile(join(root, ".reseed-staging", "some-torrent", "staged.mp4"), Buffer.alloc(600));
    await writeFile(join(root, "kept.mp4"), Buffer.alloc(600));

    const index = await buildSizeIndex(root, { excludeDirs: [join(root, ".reseed-staging")] });
    const bucket = index.get(600) ?? [];
    assert.deepEqual(bucket, [join(root, "kept.mp4")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
