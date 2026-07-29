import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTorrentDone, type ServerOptions } from "../src/server.js";

async function makeScratch() {
  const configDir = await fs.mkdtemp(join(tmpdir(), "domestique-server-config-"));
  const libraryRoot = await fs.mkdtemp(join(tmpdir(), "domestique-server-library-"));
  const downloadsPath = await fs.mkdtemp(join(tmpdir(), "domestique-server-downloads-"));
  const configPath = join(configDir, "events.json");
  const settingsPath = join(configDir, "settings.json");
  const activityPath = join(configDir, "activity.json");
  const dedupeStatePath = join(configDir, "dedupe-state.json");
  await fs.writeFile(configPath, JSON.stringify({ shows: [] }) + "\n", "utf-8");
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    activityPath,
    downloadsPath,
    dedupeStatePath,
    webui: null,
  };
  return { opts, libraryRoot, downloadsPath };
}

test("handleTorrentDone's per-file warning combines a namer warning with the real skip reason, rather than one silently hiding the other", async () => {
  const { opts, downloadsPath } = await makeScratch();
  const name = "TDF-Stage05-SBS.mp4"; // no year in the name -> triggers namer's "defaulted to <year>" warning
  await fs.writeFile(join(downloadsPath, name), Buffer.alloc(50));

  const first = await handleTorrentDone({ dir: downloadsPath, name }, opts);
  assert.equal(first[0].status, "copied");
  assert.match(first[0].warning ?? "", /no year found/i);

  // Re-processing the exact same source a second time resolves to the same
  // destination, which copyIntoLibrary now finds already exists -> skips it
  // - a real, distinct reason from the namer warning above, which also
  // still applies since it's still the same yearless name.
  const second = await handleTorrentDone({ dir: downloadsPath, name }, opts);
  assert.equal(second[0].status, "skipped");
  assert.match(second[0].warning ?? "", /no year found/i);
  assert.match(second[0].warning ?? "", /destination already exists/i);
});

test("with libraryFileMode \"hardlink\", handleTorrentDone files a real hardlink end-to-end, not a copy", async () => {
  const { opts, libraryRoot, downloadsPath } = await makeScratch();
  await fs.writeFile(
    opts.settingsPath,
    JSON.stringify({ plex: null, discord: null, hotfolder: null, libraryFileMode: "hardlink" }) + "\n",
    "utf-8"
  );
  const name = "TDF-2026-Stage05.mp4";
  const sourcePath = join(downloadsPath, name);
  await fs.writeFile(sourcePath, Buffer.alloc(50));

  const results = await handleTorrentDone({ dir: downloadsPath, name }, opts);
  assert.equal(results[0].status, "copied");

  const [sourceStat, destStat] = await Promise.all([fs.stat(sourcePath), fs.stat(results[0].destPath!)]);
  assert.equal(sourceStat.ino, destStat.ino);
});

test("a real multi-disc release (Giro 2005 (Complete), disc 1/2/3) files all three discs distinctly, no collision or Force needed", async () => {
  const { opts, downloadsPath } = await makeScratch();
  const folder = "Giro 2005 (Complete)";
  const folderPath = join(downloadsPath, folder);
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(join(folderPath, "Giro 2005 disc 1.avi"), "disc 1 bytes");
  await fs.writeFile(join(folderPath, "Giro 2005 disc 2.avi"), "disc 2 bytes");
  await fs.writeFile(join(folderPath, "Giro 2005 disc 3.avi"), "disc 3 bytes");

  const results = await handleTorrentDone({ dir: downloadsPath, name: folder }, opts);
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.status),
    ["copied", "copied", "copied"]
  );
  const destPaths = results.map((r) => r.destPath);
  assert.equal(new Set(destPaths).size, 3, "all three discs should land at distinct destinations");
  assert.ok(destPaths.some((p) => p?.endsWith("pt01.avi")));
  assert.ok(destPaths.some((p) => p?.endsWith("pt02.avi")));
  assert.ok(destPaths.some((p) => p?.endsWith("pt03.avi")));
});

test("a real raw DVD-rip release (Giro di Italia 1993, VIDEO_TS structure) files correctly: real year, one show, junk skipped, VOB segments as parts", async () => {
  const { opts, downloadsPath, libraryRoot } = await makeScratch();
  // Same shape as the real incident, including the pre-existing show entry
  // whose keywords didn't originally cover the uncontracted "di Italia"
  // phrasing - this test uses the fixed keyword list directly.
  await fs.writeFile(
    opts.configPath,
    JSON.stringify({
      shows: [
        { id: "giro-ditalia", folderName: "Giro D'Italia", matchKeywords: ["giro ditalia", "giro d italia", "giro di italia"], type: "stage-race" },
      ],
    }) + "\n",
    "utf-8"
  );

  const folder = "Giro di Italia 1993";
  const folderPath = join(downloadsPath, folder);
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(join(folderPath, "VIDEO_TS.BUP"), "nav");
  await fs.writeFile(join(folderPath, "VIDEO_TS.IFO"), "nav");
  await fs.writeFile(join(folderPath, "VIDEO_TS.VOB"), "menu video");
  await fs.writeFile(join(folderPath, "VTS_01_0.BUP"), "nav");
  await fs.writeFile(join(folderPath, "VTS_01_0.IFO"), "nav");
  for (let i = 1; i <= 5; i++) {
    await fs.writeFile(join(folderPath, `VTS_01_${i}.VOB`), `segment ${i}`);
  }

  const results = await handleTorrentDone({ dir: downloadsPath, name: folder }, opts);

  // Only the 5 real video segments were ever processed - the 5 junk
  // navigation files never even reached the pipeline.
  assert.equal(results.length, 5);
  assert.deepEqual(
    results.map((r) => r.status),
    ["copied", "copied", "copied", "copied", "copied"]
  );

  // One real show folder, no bogus auto-created "video-ts"/"vts" shows.
  const showDirs = await fs.readdir(libraryRoot);
  assert.deepEqual(showDirs, ["Giro D'Italia"]);

  // Filed under the real 1993 season, not the current year.
  const seasonDirs = await fs.readdir(join(libraryRoot, "Giro D'Italia"));
  assert.deepEqual(seasonDirs, ["Season 1993"]);

  const allEntries = await fs.readdir(join(libraryRoot, "Giro D'Italia", "Season 1993"));
  const files = allEntries.filter((f) => f.endsWith(".vob")).sort();
  assert.deepEqual(files, [
    "Giro D'Italia - S1993E01 - pt01.vob",
    "Giro D'Italia - S1993E01 - pt02.vob",
    "Giro D'Italia - S1993E01 - pt03.vob",
    "Giro D'Italia - S1993E01 - pt04.vob",
    "Giro D'Italia - S1993E01 - pt05.vob",
  ]);
});

test("a real DVD-rip release that keeps the standard VIDEO_TS folder layout (1985 Giro d'Italia) files correctly too, not just the flattened 1993 shape", async () => {
  const { opts, downloadsPath, libraryRoot } = await makeScratch();
  await fs.writeFile(
    opts.configPath,
    JSON.stringify({
      shows: [
        { id: "giro-ditalia", folderName: "Giro D'Italia", matchKeywords: ["giro ditalia", "giro d italia", "giro di italia"], type: "stage-race" },
      ],
    }) + "\n",
    "utf-8"
  );

  const folder = "1985 Giro d'Italia";
  const videoTsPath = join(downloadsPath, folder, "VIDEO_TS");
  await fs.mkdir(videoTsPath, { recursive: true });
  await fs.writeFile(join(videoTsPath, "VIDEO_TS.BUP"), "nav");
  await fs.writeFile(join(videoTsPath, "VIDEO_TS.IFO"), "nav");
  await fs.writeFile(join(videoTsPath, "VIDEO_TS.VOB"), "menu video");
  await fs.writeFile(join(videoTsPath, "VTS_01_0.BUP"), "nav");
  await fs.writeFile(join(videoTsPath, "VTS_01_0.IFO"), "nav");
  for (let i = 1; i <= 5; i++) {
    await fs.writeFile(join(videoTsPath, `VTS_01_${i}.VOB`), `segment ${i}`);
  }

  const results = await handleTorrentDone({ dir: downloadsPath, name: folder }, opts);
  assert.equal(results.length, 5, "only the 5 real video segments, nested a level deeper, should be processed");
  assert.deepEqual(
    results.map((r) => r.status),
    ["copied", "copied", "copied", "copied", "copied"]
  );

  const showDirs = await fs.readdir(libraryRoot);
  assert.deepEqual(showDirs, ["Giro D'Italia"]);
  const seasonDirs = await fs.readdir(join(libraryRoot, "Giro D'Italia"));
  assert.deepEqual(seasonDirs, ["Season 1985"]);
});
