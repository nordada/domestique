import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ServerOptions } from "../src/server.js";
import { sanitizeName } from "../src/upload.js";

test("sanitizeName strips path-traversal attempts down to a safe basename", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("/etc/passwd"), "passwd");
  assert.equal(sanitizeName("Tour-de-France-Stage-05.mp4"), "Tour-de-France-Stage-05.mp4");
  assert.throws(() => sanitizeName(".."));
  assert.throws(() => sanitizeName("."));
  assert.throws(() => sanitizeName(""));
});

async function makeScratchServer(webui: { password: string; username?: string } | null) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-upload-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-upload-library-"));
  const configPath = join(configDir, "events.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      shows: [{ id: "tdf", folderName: "Tour de France", matchKeywords: ["tour de france", "tdf"], type: "stage-race" }],
    }) + "\n",
    "utf-8"
  );

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    plex: null,
    discord: null,
    webui,
  };

  const server = createApp(opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    libraryRoot,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authHeader(password: string, username = "anything"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("POST /api/upload/file archives a single-file upload and cleans up the staged copy", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${baseUrl}/api/upload/file?name=${encodeURIComponent("TDF-2026-Stage05-1080p.mp4")}`, {
      method: "POST",
      headers: { Authorization: authHeader("correct-password") },
      body: "fake video bytes",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ status: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.results[0].status, "copied");

    const archived = await fs.readFile(
      join(libraryRoot, "Tour de France", "Season 2026", "Tour de France - S2026E05 - Stage 5.mp4"),
      "utf-8"
    );
    assert.equal(archived, "fake video bytes");

    const stagingRoot = join(libraryRoot, ".uploads-tmp");
    const stagedFiles = await fs.readdir(stagingRoot).catch(() => []);
    assert.equal(stagedFiles.length, 0); // deleted after successful processing
  } finally {
    await close();
  }
});

test("folder upload: folder-start, two folder-file uploads, then folder-finalize groups parts and cleans up", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const folder = "TDF-2026-Stage06-Multipart";
    const auth = authHeader("correct-password");

    const startRes = await fetch(`${baseUrl}/api/upload/folder-start?folder=${encodeURIComponent(folder)}`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    assert.equal(startRes.status, 200);

    for (const [name, contents] of [
      ["Part-1-of-2.mp4", "part one bytes"],
      ["Part-2-of-2.mp4", "part two bytes"],
    ] as const) {
      const res = await fetch(
        `${baseUrl}/api/upload/folder-file?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { Authorization: auth }, body: contents }
      );
      assert.equal(res.status, 200);
    }

    const finalizeRes = await fetch(`${baseUrl}/api/upload/folder-finalize?folder=${encodeURIComponent(folder)}`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    assert.equal(finalizeRes.status, 200);
    const body = (await finalizeRes.json()) as { ok: boolean; results: Array<{ status: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 2);
    assert.ok(body.results.every((r) => r.status === "copied"));

    const seasonDir = join(libraryRoot, "Tour de France", "Season 2026");
    const part1 = await fs.readFile(join(seasonDir, "Tour de France - S2026E06 - Stage 6 - pt01.mp4"), "utf-8");
    const part2 = await fs.readFile(join(seasonDir, "Tour de France - S2026E06 - Stage 6 - pt02.mp4"), "utf-8");
    assert.equal(part1, "part one bytes");
    assert.equal(part2, "part two bytes");

    const stagingRoot = join(libraryRoot, ".uploads-tmp");
    const remaining = await fs.readdir(stagingRoot).catch(() => []);
    assert.equal(remaining.length, 0); // whole batch folder removed after successful processing
  } finally {
    await close();
  }
});

test("folder-start clears a stale leftover from a previous incomplete batch of the same name", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const folder = "Stale-Batch";
    const auth = authHeader("correct-password");
    const folderDir = join(libraryRoot, ".uploads-tmp", folder);

    // Simulate a leftover from a batch that was never finalized.
    await fs.mkdir(folderDir, { recursive: true });
    await fs.writeFile(join(folderDir, "leftover-junk.mp4"), "stale bytes");

    const startRes = await fetch(`${baseUrl}/api/upload/folder-start?folder=${encodeURIComponent(folder)}`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    assert.equal(startRes.status, 200);

    const entries = await fs.readdir(folderDir);
    assert.deepEqual(entries, []); // stale file gone, fresh empty folder in its place
  } finally {
    await close();
  }
});

test("upload routes are gated the same way as the rest of the web UI: 503 disabled, 401 unauthorized", async () => {
  const disabled = await makeScratchServer(null);
  try {
    const res = await fetch(`${disabled.baseUrl}/api/upload/file?name=x.mp4`, { method: "POST", body: "x" });
    assert.equal(res.status, 503);
  } finally {
    await disabled.close();
  }

  const enabled = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${enabled.baseUrl}/api/upload/file?name=x.mp4`, { method: "POST", body: "x" });
    assert.equal(res.status, 401);
  } finally {
    await enabled.close();
  }
});
