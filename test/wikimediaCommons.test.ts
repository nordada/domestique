import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { searchCommonsLogos, fetchCommonsFile } from "../src/wikimediaCommons.js";

async function withStub(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("searchCommonsLogos parses a realistic Commons API response into flat results", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        query: {
          pages: {
            "111": {
              title: "File:Tour de France logo.svg",
              imageinfo: [{ url: "https://upload.wikimedia.org/x/TdF.svg", thumburl: "https://upload.wikimedia.org/x/thumb/TdF.png" }],
            },
            "222": {
              title: "File:Tour de France 2023 logo.png",
              imageinfo: [{ url: "https://upload.wikimedia.org/x/TdF2023.png" }], // no thumburl - falls back to the full url
            },
            "333": { title: "File:Something with no imageinfo" }, // dropped - no usable url
          },
        },
      })
    );
  });
  try {
    const results = await searchCommonsLogos("tour de france logo", { apiUrl: stub.url });
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      title: "File:Tour de France logo.svg",
      fileUrl: "https://upload.wikimedia.org/x/TdF.svg",
      thumbUrl: "https://upload.wikimedia.org/x/thumb/TdF.png",
    });
    assert.deepEqual(results[1], {
      title: "File:Tour de France 2023 logo.png",
      fileUrl: "https://upload.wikimedia.org/x/TdF2023.png",
      thumbUrl: "https://upload.wikimedia.org/x/TdF2023.png", // fell back to fileUrl
    });
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
    await assert.rejects(searchCommonsLogos("x", { apiUrl: stub.url }), /503/);
  } finally {
    await stub.close();
  }
});

test("searchCommonsLogos returns an empty array when the query has no matches", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ query: {} }));
  });
  try {
    const results = await searchCommonsLogos("something with no results", { apiUrl: stub.url });
    assert.deepEqual(results, []);
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
