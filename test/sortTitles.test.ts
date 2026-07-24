import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { formatSortTitle, syncSortTitlesToPlex } from "../src/sortTitles.js";
import type { ShowsConfigFile } from "../src/config.js";
import type { PlexConfig } from "../src/plex.js";

test("formatSortTitle zero-pads to 2 digits and appends the show's own folder name", () => {
  assert.equal(formatSortTitle(1, "Tour Down Under"), "01 Tour Down Under");
  assert.equal(formatSortTitle(9, "UAE Tour"), "09 UAE Tour");
  assert.equal(formatSortTitle(23, "Il Lombardia"), "23 Il Lombardia");
  assert.equal(formatSortTitle(100, "Overflow Race"), "100 Overflow Race"); // not truncated past 2 digits, just no longer padded
});

/**
 * The same Plex `/library/sections/{id}/all` path is used both for the
 * ratingKey-index GET (fetchShowRatingKeyIndex) and the sort-title-update
 * PUT (setShowSortTitle) - this stub distinguishes them by HTTP method,
 * matching the two real, different calls syncSortTitlesToPlex makes.
 */
function makePlexStub(knownShows: Array<{ ratingKey: string; path: string }>) {
  const sortTitleUpdates: Array<{ id: string; titleSortValue: string; locked: string | null }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (req.method === "GET" && url.pathname.endsWith("/all")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        MediaContainer: { Metadata: knownShows.map((s) => ({ ratingKey: s.ratingKey, Location: [{ path: s.path }] })) },
      }));
      return;
    }
    if (req.method === "PUT" && url.pathname.endsWith("/all")) {
      sortTitleUpdates.push({
        id: url.searchParams.get("id") ?? "",
        titleSortValue: url.searchParams.get("titleSort.value") ?? "",
        locked: url.searchParams.get("titleSort.locked"),
      });
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, sortTitleUpdates };
}

async function withStub(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  return {
    plex: { url: `http://127.0.0.1:${address.port}`, token: "tok", sectionId: "35", libraryRoot: "/library" } satisfies PlexConfig,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("syncSortTitlesToPlex pushes a locked, formatted sort title for every show with a sortOrder set", async () => {
  const { server, sortTitleUpdates } = makePlexStub([
    { ratingKey: "111", path: "/library/Tour Down Under" },
    { ratingKey: "222", path: "/library/UAE Tour" },
  ]);
  const { plex, close } = await withStub(server);
  try {
    const config: ShowsConfigFile = {
      shows: [
        { id: "tdu", folderName: "Tour Down Under", matchKeywords: ["tdu"], type: "stage-race", sortOrder: 1 },
        { id: "uae", folderName: "UAE Tour", matchKeywords: ["uae"], type: "stage-race", sortOrder: 2 },
        { id: "no-order", folderName: "Some Other Race", matchKeywords: ["x"], type: "one-day" }, // no sortOrder - skipped entirely, not even looked up
      ],
    };
    const results = await syncSortTitlesToPlex(config, plex, "/library");
    assert.equal(results.length, 2); // the no-sortOrder show never appears in results at all
    assert.deepEqual(results, [
      { id: "tdu", status: "synced" },
      { id: "uae", status: "synced" },
    ]);
    assert.equal(sortTitleUpdates.length, 2);
    assert.deepEqual(sortTitleUpdates[0], { id: "111", titleSortValue: "01 Tour Down Under", locked: "1" });
    assert.deepEqual(sortTitleUpdates[1], { id: "222", titleSortValue: "02 UAE Tour", locked: "1" });
  } finally {
    await close();
  }
});

test("syncSortTitlesToPlex skips (not errors) a show with sortOrder set that Plex hasn't indexed yet", async () => {
  const { server, sortTitleUpdates } = makePlexStub([]); // Plex knows about no shows at all
  const { plex, close } = await withStub(server);
  try {
    const config: ShowsConfigFile = {
      shows: [{ id: "brand-new", folderName: "Brand New Race", matchKeywords: ["x"], type: "one-day", sortOrder: 5 }],
    };
    const results = await syncSortTitlesToPlex(config, plex, "/library");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
    assert.match(results[0].reason ?? "", /not yet indexed/);
    assert.equal(sortTitleUpdates.length, 0);
  } finally {
    await close();
  }
});

test("syncSortTitlesToPlex returns an empty array without making any Plex request when no show has a sortOrder", async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  });
  const { plex, close } = await withStub(server);
  try {
    const config: ShowsConfigFile = {
      shows: [{ id: "x", folderName: "X", matchKeywords: ["x"], type: "one-day" }],
    };
    const results = await syncSortTitlesToPlex(config, plex, "/library");
    assert.deepEqual(results, []);
    assert.equal(requestCount, 0); // not even the ratingKey index fetch happened
  } finally {
    await close();
  }
});
