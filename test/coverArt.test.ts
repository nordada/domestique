import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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

test("regenerateAllCoverArt applies a show's per-event coverArt override instead of the global colors", async () => {
  const libraryRoot = await makeScratchLibrary();
  await stageLogo(libraryRoot, TDF.id);
  const tdfWithOverride: ShowConfig = { ...TDF, coverArt: { backgroundColor: "#00ff00", logoScale: 1.0 } };

  const results = await regenerateAllCoverArt({ shows: [tdfWithOverride] }, DEFAULT_COVER_ART, libraryRoot);
  assert.equal(results[0].result.status, "written");

  // The corner pixels are pure background (the logo only covers the center),
  // so a green corner confirms the override's color won, not the global navy.
  const { data } = await sharp(results[0].result.posterPath!).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0], data[1], data[2]];
  assert.ok(g > r && g > b, `expected a green-dominant corner pixel, got rgb(${r},${g},${b})`);
});

async function makeScratchServer(webui: { password: string; username?: string } | null, shows: ShowConfig[] = [TDF]) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-coverart-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-coverart-lib-"));
  const configPath = join(configDir, "events.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ shows }) + "\n",
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

    // Just over the 8 MB cap, not far over it - minimizes the amount of
    // still-unsent data in flight when the server aborts the connection,
    // which otherwise raced an EPIPE on the client write often enough in
    // practice to make this test genuinely flaky at a much larger overage.
    const oversized = Buffer.alloc(8_050_000, 1);
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

/**
 * Simulates enough of Plex's real API for refreshPlexForShow's two paths:
 * `/library/sections/{id}/all?type=2` (the ratingKey lookup, returns
 * `knownShows` as Metadata with a Location) and both refresh endpoints
 * (`/refresh?path=` passive, `/library/metadata/{key}/refresh` forced).
 */
function makePlexStub(knownShows: Array<{ ratingKey: string; path: string }>) {
  const passiveRefreshPaths: string[] = [];
  const forceRefreshRatingKeys: string[] = [];
  let allRequestCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname.endsWith("/all")) {
      allRequestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        MediaContainer: { Metadata: knownShows.map((s) => ({ ratingKey: s.ratingKey, Location: [{ path: s.path }] })) },
      }));
      return;
    }
    const metadataRefreshMatch = url.pathname.match(/\/library\/metadata\/([^/]+)\/refresh$/);
    if (metadataRefreshMatch) {
      forceRefreshRatingKeys.push(metadataRefreshMatch[1]);
      res.writeHead(200);
      res.end();
      return;
    }
    passiveRefreshPaths.push(url.searchParams.get("path") ?? "");
    res.writeHead(200);
    res.end();
  });
  return { server, passiveRefreshPaths, forceRefreshRatingKeys, getAllRequestCount: () => allRequestCount };
}

test("POST /api/cover-art/regenerate falls back to a passive folder refresh when Plex doesn't know the show yet", async () => {
  const { server: plexStub, passiveRefreshPaths, forceRefreshRatingKeys } = makePlexStub([]); // Plex has no matching show - simulates a brand-new show
  await new Promise<void>((resolve) => plexStub.listen(0, resolve));
  const plexAddress = plexStub.address();
  if (plexAddress === null || typeof plexAddress === "string") throw new Error("expected a bound port");

  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const auth = authHeader("correct-password");
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ plex: { url: `http://127.0.0.1:${plexAddress.port}`, sectionId: "35" }, plexToken: "fake-token" }),
    });

    // A show with no logo shouldn't trigger a refresh at all - nothing was written for it.
    await fetch(`${baseUrl}/api/cover-art/regenerate`, { method: "POST", headers: { Authorization: auth } });
    assert.equal(passiveRefreshPaths.length, 0);
    assert.equal(forceRefreshRatingKeys.length, 0);

    await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, { method: "POST", headers: { Authorization: auth }, body: await tinyPng() });
    await fetch(`${baseUrl}/api/cover-art/regenerate`, { method: "POST", headers: { Authorization: auth } });

    assert.equal(passiveRefreshPaths.length, 1);
    assert.match(passiveRefreshPaths[0], /Tour de France$/);
    assert.equal(forceRefreshRatingKeys.length, 0);
  } finally {
    await close();
    await new Promise<void>((resolve) => plexStub.close(() => resolve()));
  }
});

test("POST /api/cover-art/regenerate forces a per-item Plex refresh (not a passive scan) for a show Plex already knows about", async () => {
  const { server: plexStub, passiveRefreshPaths, forceRefreshRatingKeys } = makePlexStub([
    { ratingKey: "999", path: "/media/library/Tour de France" },
  ]);
  await new Promise<void>((resolve) => plexStub.listen(0, resolve));
  const plexAddress = plexStub.address();
  if (plexAddress === null || typeof plexAddress === "string") throw new Error("expected a bound port");

  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" });
  try {
    const auth = authHeader("correct-password");
    // libraryRoot is translated to Plex's "/media/library" view, matching this stub's known show path exactly.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        plex: { url: `http://127.0.0.1:${plexAddress.port}`, sectionId: "35", libraryRoot: "/media/library" },
        plexToken: "fake-token",
      }),
    });

    await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, { method: "POST", headers: { Authorization: auth }, body: await tinyPng() });
    await fetch(`${baseUrl}/api/cover-art/regenerate`, { method: "POST", headers: { Authorization: auth } });

    assert.equal(forceRefreshRatingKeys.length, 1);
    assert.equal(forceRefreshRatingKeys[0], "999");
    assert.equal(passiveRefreshPaths.length, 0); // the force refresh replaces the passive one entirely, not both
  } finally {
    await close();
    await new Promise<void>((resolve) => plexStub.close(() => resolve()));
  }
});

test("POST /api/cover-art/regenerate fetches Plex's ratingKey index once for the whole batch, not once per show", async () => {
  const giro: ShowConfig = { id: "giro", folderName: "Giro D'Italia", matchKeywords: ["giro"], type: "stage-race" };
  const { server: plexStub, forceRefreshRatingKeys, getAllRequestCount } = makePlexStub([
    { ratingKey: "111", path: "/media/library/Tour de France" },
    { ratingKey: "222", path: "/media/library/Giro D'Italia" },
  ]);
  await new Promise<void>((resolve) => plexStub.listen(0, resolve));
  const plexAddress = plexStub.address();
  if (plexAddress === null || typeof plexAddress === "string") throw new Error("expected a bound port");

  const { baseUrl, close } = await makeScratchServer({ password: "correct-password" }, [TDF, giro]);
  try {
    const auth = authHeader("correct-password");
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        plex: { url: `http://127.0.0.1:${plexAddress.port}`, sectionId: "35", libraryRoot: "/media/library" },
        plexToken: "fake-token",
      }),
    });

    await fetch(`${baseUrl}/api/cover-art/logo?showId=tdf`, { method: "POST", headers: { Authorization: auth }, body: await tinyPng() });
    await fetch(`${baseUrl}/api/cover-art/logo?showId=giro`, { method: "POST", headers: { Authorization: auth }, body: await tinyPng() });
    await fetch(`${baseUrl}/api/cover-art/regenerate`, { method: "POST", headers: { Authorization: auth } });

    // The whole point of the fix: two shows refreshed, but only one fetch of
    // Plex's section listing - an earlier version fetched it once per show,
    // which made regenerating a real library's worth of logo'd shows slow
    // enough in practice to look hung.
    assert.equal(getAllRequestCount(), 1);
    assert.equal(forceRefreshRatingKeys.sort().join(","), "111,222");
  } finally {
    await close();
    await new Promise<void>((resolve) => plexStub.close(() => resolve()));
  }
});
