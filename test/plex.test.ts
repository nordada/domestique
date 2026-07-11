import { test } from "node:test";
import assert from "node:assert/strict";
import { plexConfigFromEnv, plexLibraryUrl } from "../src/plex.js";

test("plexConfigFromEnv returns null unless URL, token, and section id are all set", () => {
  const saved = {
    PLEX_URL: process.env.PLEX_URL,
    PLEX_TOKEN: process.env.PLEX_TOKEN,
    PLEX_SECTION_ID: process.env.PLEX_SECTION_ID,
    PLEX_LIBRARY_ROOT: process.env.PLEX_LIBRARY_ROOT,
  };
  try {
    delete process.env.PLEX_URL;
    delete process.env.PLEX_TOKEN;
    delete process.env.PLEX_SECTION_ID;
    delete process.env.PLEX_LIBRARY_ROOT;
    assert.equal(plexConfigFromEnv("/library"), null);

    process.env.PLEX_URL = "http://192.168.1.24:32400/";
    process.env.PLEX_TOKEN = "abc123";
    assert.equal(plexConfigFromEnv("/library"), null); // still missing section id

    process.env.PLEX_SECTION_ID = "5";
    const config = plexConfigFromEnv("/library");
    assert.ok(config);
    assert.equal(config?.url, "http://192.168.1.24:32400"); // trailing slash stripped
    assert.equal(config?.token, "abc123");
    assert.equal(config?.sectionId, "5");
    assert.equal(config?.libraryRoot, "/library"); // falls back to LIBRARY_ROOT

    process.env.PLEX_LIBRARY_ROOT = "/data/racing";
    const config2 = plexConfigFromEnv("/library");
    assert.equal(config2?.libraryRoot, "/data/racing");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("plexLibraryUrl builds a direct link to the configured section using the server's machineIdentifier", () => {
  const plex = { url: "http://192.168.1.24:32400", token: "abc123", sectionId: "35", libraryRoot: "/library" };
  assert.equal(
    plexLibraryUrl(plex, "deadbeef1234"),
    "http://192.168.1.24:32400/web/index.html#!/media/deadbeef1234/com.plexapp.plugins.library?source=35"
  );
});
