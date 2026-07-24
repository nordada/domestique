import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { searchCommonsLogos, fetchCommonsFile } from "../src/wikimediaCommons.js";

async function withStub(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * searchCommonsLogos tries four tiers in order (Wikipedia title-scoped,
 * Wikipedia broad, Commons title-scoped, Commons broad) - both apiUrl and
 * wikipediaApiUrl are pointed at this same stub in every test below, and
 * this distinguishes which tier a given request belongs to by its actual
 * query params: piprop only appears on Wikipedia requests (vs. Commons'
 * iiprop), and intitle: only appears in a title-scoped gsrsearch value -
 * exactly the shape the real four separate HTTP calls take, not an
 * artificial stand-in for them.
 */
function stubResponseFor(page: {
  wikipediaTitle: unknown;
  wikipediaBroad: unknown;
  commonsTitle: unknown;
  commonsBroad: unknown;
}): RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? "", "http://internal");
    const isWikipedia = url.searchParams.has("piprop");
    const isTitleScoped = (url.searchParams.get("gsrsearch") ?? "").includes("intitle:");
    const body = isWikipedia
      ? isTitleScoped
        ? page.wikipediaTitle
        : page.wikipediaBroad
      : isTitleScoped
        ? page.commonsTitle
        : page.commonsBroad;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const EMPTY = { query: {} };

test("searchCommonsLogos prefers a title-scoped Wikipedia article's page image, with broadened:false", async () => {
  const stub = await withStub(
    stubResponseFor({
      wikipediaTitle: {
        query: {
          pages: {
            "1": {
              title: "Tour de France",
              thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/x/TdF-thumb.png" },
              original: { source: "https://upload.wikimedia.org/wikipedia/commons/x/TdF-logo.svg" },
            },
            "2": { title: "2024 Tour de France" }, // dropped - no page image at all
          },
        },
      },
      // None of these should ever be reached - tier 1 already succeeded.
      wikipediaBroad: EMPTY,
      commonsTitle: EMPTY,
      commonsBroad: EMPTY,
    })
  );
  try {
    const { results, broadened } = await searchCommonsLogos("Tour de France", { apiUrl: stub.url, wikipediaApiUrl: stub.url });
    assert.equal(broadened, false);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "Tour de France",
      fileUrl: "https://upload.wikimedia.org/wikipedia/commons/x/TdF-logo.svg",
      thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/x/TdF-thumb.png",
    });
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos falls back to broad Wikipedia search when the title-scoped attempt has no image-bearing article, still broadened:true", async () => {
  const stub = await withStub(
    stubResponseFor({
      wikipediaTitle: { query: { pages: { "1": { title: "Some Race" } } } }, // matched, but no page image
      wikipediaBroad: {
        query: {
          pages: {
            "2": {
              title: "Some Race (broad match)",
              original: { source: "https://upload.wikimedia.org/wikipedia/commons/x/broad.jpg" },
            },
          },
        },
      },
      commonsTitle: EMPTY, // should never be reached
      commonsBroad: EMPTY,
    })
  );
  try {
    const { results, broadened } = await searchCommonsLogos("Some Race", { apiUrl: stub.url, wikipediaApiUrl: stub.url });
    assert.equal(broadened, true);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Some Race (broad match)");
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos falls back to Commons title-scoped search when neither Wikipedia tier finds an image", async () => {
  const stub = await withStub(
    stubResponseFor({
      wikipediaTitle: EMPTY,
      wikipediaBroad: EMPTY,
      commonsTitle: {
        query: {
          pages: {
            "111": {
              title: "File:Some Race logo.svg",
              imageinfo: [{ url: "https://upload.wikimedia.org/x/logo.svg", thumburl: "https://upload.wikimedia.org/x/thumb-logo.png" }],
            },
          },
        },
      },
      commonsBroad: EMPTY, // should never be reached
    })
  );
  try {
    const { results, broadened } = await searchCommonsLogos("Some Race", { apiUrl: stub.url, wikipediaApiUrl: stub.url });
    assert.equal(broadened, true);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "File:Some Race logo.svg");
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos falls back all the way to Commons' broad search when nothing else finds anything", async () => {
  const stub = await withStub(
    stubResponseFor({
      wikipediaTitle: EMPTY,
      wikipediaBroad: EMPTY,
      commonsTitle: EMPTY,
      commonsBroad: {
        query: {
          pages: {
            "444": {
              title: "File:Some loosely related file.jpg",
              imageinfo: [{ url: "https://upload.wikimedia.org/x/loose.jpg" }],
            },
          },
        },
      },
    })
  );
  try {
    const { results, broadened } = await searchCommonsLogos("obscure race", { apiUrl: stub.url, wikipediaApiUrl: stub.url });
    assert.equal(broadened, true);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "File:Some loosely related file.jpg",
      fileUrl: "https://upload.wikimedia.org/x/loose.jpg",
      thumbUrl: "https://upload.wikimedia.org/x/loose.jpg", // no thumburl - falls back to fileUrl
    });
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos caps returned results at `limit` even when the raw Wikipedia fetch found more", async () => {
  const manyPages: Record<string, unknown> = {};
  for (let i = 0; i < 5; i++) {
    manyPages[String(i)] = { title: `Race Edition ${i}`, original: { source: `https://upload.wikimedia.org/x/${i}.jpg` } };
  }
  const stub = await withStub(
    stubResponseFor({
      wikipediaTitle: { query: { pages: manyPages } },
      wikipediaBroad: EMPTY,
      commonsTitle: EMPTY,
      commonsBroad: EMPTY,
    })
  );
  try {
    const { results } = await searchCommonsLogos("Race", { apiUrl: stub.url, wikipediaApiUrl: stub.url, limit: 2 });
    assert.equal(results.length, 2);
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos throws on a non-ok response", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(503);
    res.end();
  });
  try {
    await assert.rejects(searchCommonsLogos("x", { apiUrl: stub.url, wikipediaApiUrl: stub.url }), /503/);
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos returns an empty result set (broadened:true) when nothing at all matches", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(EMPTY));
  });
  try {
    const { results, broadened } = await searchCommonsLogos("something with no results", { apiUrl: stub.url, wikipediaApiUrl: stub.url });
    assert.deepEqual(results, []);
    assert.equal(broadened, true);
  } finally {
    await stub.close();
  }
});

test("fetchCommonsFile fetches and returns the raw bytes when the host matches", async () => {
  const bytes = Buffer.from("fake image bytes");
  const stub = await withStub((req, res) => {
    res.writeHead(200);
    res.end(bytes);
  });
  const stubHost = new URL(stub.url).hostname; // fetchCommonsFile checks .hostname (no port), not .host
  try {
    const result = await fetchCommonsFile(`${stub.url}/File.png`, { allowedHost: stubHost });
    assert.deepEqual(result, bytes);
  } finally {
    await stub.close();
  }
});

test("fetchCommonsFile refuses to fetch from a host other than the allowed one - the SSRF guard", async () => {
  // No stub server needed at all - the host check must happen before any
  // network call, so this proves the guard doesn't just rely on the fetch
  // itself failing for an unrelated reason.
  await assert.rejects(
    fetchCommonsFile("http://169.254.169.254/latest/meta-data/", { allowedHost: "upload.wikimedia.org" }),
    /refusing to fetch from unexpected host/
  );
});

test("fetchCommonsFile enforces its byte-size cap rather than buffering an unbounded response", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(200, 1));
  });
  const stubHost = new URL(stub.url).hostname;
  try {
    // maxBytes deliberately far below the stub's actual 200-byte response -
    // proves the running total is checked as bytes arrive, not trusted from
    // a Content-Length header (real responses aren't guaranteed to send one
    // accurately).
    await assert.rejects(
      fetchCommonsFile(`${stub.url}/big.png`, { allowedHost: stubHost, maxBytes: 50 }),
      /exceeds 50 byte limit/
    );
  } finally {
    await stub.close();
  }
});
