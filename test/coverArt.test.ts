import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp, type ServerOptions } from "../src/server.js";
import { generateCoverArt, regenerateAllCoverArt } from "../src/coverArt.js";
import type { ShowConfig } from "../src/config.js";
import type { CoverArtSettings } from "../src/settings.js";

const DEFAULT_COVER_ART: CoverArtSettings = {
  enabled: true,
  backgroundColor: "#14213d",
  backgroundColor2: null,
  logoScale: 0.72,
};

const TDF: ShowConfig = {
  id: "tdf",
  folderName: "Tour de France",
  matchKeywords: ["tour de france", "tdf"],
  type: "stage-race",
};

async function makeScratchLibrary() {
  return fs.mkdtemp(join(tmpdir(), "domestique-coverart-library-"));
}

async function tinyPng(color = "#ff0000"): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).png().toBuffer();
}

async function stageLogo(libraryRoot: string, showId: string, color?: string): Promise<void> {
  const logoDir = join(libraryRoot, ".cover-art", "logos");
  await fs.mkdir(logoDir, { recursive: true });
  await fs.writeFile(join(logoDir, `${showId}.png`), await tinyPng(color));
}

test("generateCoverArt is a no-op for a show with no uploaded logo - no placeholder poster is generated", async () => {
  const libraryRoot = await makeScratchLibrary();
  const result = await generateCoverArt(TDF, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(result.status, "skipped");
  await assert.rejects(fs.stat(join(libraryRoot, "Tour de France", "poster.jpg")));
});

test("generateCoverArt writes a 1000x1500 JPEG compositing the uploaded logo once one exists on disk", async () => {
  const libraryRoot = await makeScratchLibrary();
  await stageLogo(libraryRoot, TDF.id);

  const result = await generateCoverArt(TDF, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(result.status, "written");
  const meta = await sharp(result.posterPath!).metadata();
  assert.equal(meta.width, 1000);
  assert.equal(meta.height, 1500);
  assert.equal(meta.format, "jpeg");

  // tmp file must not be left behind
  const files = await fs.readdir(join(libraryRoot, "Tour de France"));
  assert.deepEqual(files.sort(), ["poster.jpg"]);
});

test("generateCoverArt skips an already-existing poster unless force is set", async () => {
  const libraryRoot = await makeScratchLibrary();
  await stageLogo(libraryRoot, TDF.id);

  const first = await generateCoverArt(TDF, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(first.status, "written");
  const firstStat = await fs.stat(first.posterPath!);

  const skipped = await generateCoverArt(TDF, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(skipped.status, "skipped");

  await new Promise((r) => setTimeout(r, 20));
  const forced = await generateCoverArt(TDF, DEFAULT_COVER_ART, libraryRoot, { force: true });
  assert.equal(forced.status, "written");
  const forcedStat = await fs.stat(forced.posterPath!);
  assert.ok(forcedStat.mtimeMs >= firstStat.mtimeMs);
});

test("regenerateAllCoverArt only writes a poster for shows with an uploaded logo, force or not", async () => {
  const libraryRoot = await makeScratchLibrary();
  const giro: ShowConfig = { id: "giro", folderName: "Giro D'Italia", matchKeywords: ["giro"], type: "stage-race" };
  await stageLogo(libraryRoot, TDF.id); // only tdf has a logo - giro does not

  const results = await regenerateAllCoverArt({ shows: [TDF, giro] }, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.id === "tdf")?.result.status, "written");
  assert.equal(results.find((r) => r.id === "giro")?.result.status, "skipped");
  await assert.doesNotReject(fs.stat(join(libraryRoot, "Tour de France", "poster.jpg")));
  await assert.rejects(fs.stat(join(libraryRoot, "Giro D'Italia", "poster.jpg")));
});

async function makeScratchServer(webui: { password: string; username?: string } | null) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-coverart-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-coverart-lib-"));
  const configPath = join(configDir, "events.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ shows: [TDF] }) + "\n",
    "utf-8"
  );

  const settingsPath = join(configDir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    activityPath: join(configDir, "activity.json"),
    downloadsPath: "/nonexistent",
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

test("POST/GET/DELETE /api/cover-art/logo round-trips a normalized PNG for a real config id", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const auth = authHeader("correct-password");
    const png = await tinyPng("#00ff00");

    const uploadRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      method: "POST",
      headers: { Authorization: auth },
      body: png,
    });
    assert.equal(uploadRes.status, 200);

    const onDisk = await fs.readFile(join(libraryRoot, ".cover-art", "logos", "tdf.png"));
    const onDiskMeta = await sharp(onDisk).metadata();
    assert.equal(onDiskMeta.format, "png");

    const getRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, { headers: { Authorization: auth } });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("content-type"), "image/png");

    const deleteRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    assert.equal(deleteRes.status, 200);

    const getAfterDeleteRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      headers: { Authorization: auth },
    });
    assert.equal(getAfterDeleteRes.status, 404);
  } finally {
    await close();
  }
});

test("POST /api/cover-art/logo rejects an unknown showId, oversized body, and non-image bytes", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const auth = authHeader("correct-password");

    const unknownRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=not-a-real-show`, {
      method: "POST",
      headers: { Authorization: auth },
      body: await tinyPng(),
    });
    assert.equal(unknownRes.status, 400);

    const notAnImageRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      method: "POST",
      headers: { Authorization: auth },
      body: "definitely not image bytes",
    });
    assert.equal(notAnImageRes.status, 400);

    const oversized = Buffer.alloc(9_000_000, 1);
    const oversizedRes = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      method: "POST",
      headers: { Authorization: auth },
      body: oversized,
    });
    assert.equal(oversizedRes.status, 413);
  } finally {
    await close();
  }
});

test("GET /api/cover-art/logo 404s when no logo has been set for a real show", async () => {
  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const res = await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, {
      headers: { Authorization: authHeader("correct-password") },
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("POST /api/cover-art/regenerate skips a show with no logo, and force-regenerates one that has one", async () => {
  const { baseUrl, libraryRoot, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const auth = authHeader("correct-password");

    // No logo uploaded yet - regenerate should be a no-op for "tdf".
    const beforeRes = await fetch(`${baseUrl}/api/cover-art/regenerate`, { method: "POST", headers: { Authorization: auth } });
    const beforeBody = (await beforeRes.json()) as { results: Array<{ id: string; result: { status: string } }> };
    assert.equal(beforeBody.results[0].result.status, "skipped");
    await assert.rejects(fs.stat(join(libraryRoot, "Tour de France", "poster.jpg")));

    await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, { method: "POST", headers: { Authorization: auth }, body: await tinyPng() });

    const res = await fetch(`${baseUrl}/api/cover-art/regenerate`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ id: string; result: { status: string } }> };
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].id, "tdf");
    assert.equal(body.results[0].result.status, "written");
    await fs.stat(join(libraryRoot, "Tour de France", "poster.jpg"));
  } finally {
    await close();
  }
});
