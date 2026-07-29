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
  await fs.writeFile(configPath, JSON.stringify({ shows: [] }) + "\n", "utf-8");
  await fs.writeFile(settingsPath, JSON.stringify({ plex: null, discord: null, hotfolder: null }) + "\n", "utf-8");

  const opts: ServerOptions = {
    port: 0,
    libraryRoot,
    configPath,
    settingsPath,
    activityPath,
    downloadsPath,
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
