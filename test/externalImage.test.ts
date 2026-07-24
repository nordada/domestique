import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchExternalImage } from "../src/externalImage.js";
import { assertPublicHostname } from "../src/ssrfGuard.js";

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

// Every local stub in these tests binds to 127.0.0.1, which the real SSRF
// guard correctly blocks - so tests that need to actually reach the stub
// use this permissive stand-in instead of the real assertPublicHostname
// (production code never does this; see fetchExternalImage's own doc
// comment on the hostCheck param).
const allowLoopback = async () => {};

test("fetchExternalImage rejects a private/loopback URL before making any request - the real, non-overridden guard", async () => {
  // No stub server needed, and no hostCheck override - this exercises the
  // actual default (assertPublicHostname), proving production behavior
  // really does reject these outright with zero network calls.
  await assert.rejects(fetchExternalImage("http://127.0.0.1:1/x.png"), /refusing to fetch/);
  await assert.rejects(fetchExternalImage("http://192.168.1.24/x.png"), /refusing to fetch/);
  await assert.rejects(fetchExternalImage("http://169.254.169.254/latest/meta-data/"), /refusing to fetch/);
});

test("fetchExternalImage rejects a non-http(s) scheme", async () => {
  await assert.rejects(fetchExternalImage("file:///etc/passwd"), /unsupported URL scheme/);
});

test("fetchExternalImage fetches and returns bytes from a successful response", async () => {
  const bytes = Buffer.from("fake image bytes");
  const stub = await withStub((req, res) => {
    res.writeHead(200);
    res.end(bytes);
  });
  try {
    const result = await fetchExternalImage(stub.url, { hostCheck: allowLoopback });
    assert.deepEqual(result, bytes);
  } finally {
    await stub.close();
  }
});

test("fetchExternalImage follows a redirect chain and re-validates each hop's host with the real guard", async () => {
  // hostCheck here allows the stub's own loopback address specifically,
  // but delegates every other hostname to the REAL assertPublicHostname -
  // so the redirect target (a real private LAN address) is judged by
  // production logic, not the test's own leniency. Proves the guard
  // applies to every hop, not just the initial URL - a redirect is exactly
  // how an otherwise-blocked fetch could be smuggled through if only the
  // first host were checked.
  const stub = await withStub((req, res) => {
    res.writeHead(302, { Location: "http://192.168.1.24/internal.png" });
    res.end();
  });
  const hostCheck = async (hostname: string) => {
    if (hostname === "127.0.0.1") return;
    await assertPublicHostname(hostname);
  };
  try {
    await assert.rejects(fetchExternalImage(stub.url, { hostCheck }), /refusing to fetch/);
  } finally {
    await stub.close();
  }
});

test("fetchExternalImage gives up after too many redirects rather than looping forever", async () => {
  const stub = await withStub((req, res) => {
    // Every request redirects to itself - an infinite loop if not capped.
    res.writeHead(302, { Location: req.url });
    res.end();
  });
  try {
    await assert.rejects(fetchExternalImage(stub.url, { hostCheck: allowLoopback }), /too many redirects/);
  } finally {
    await stub.close();
  }
});

test("fetchExternalImage enforces its byte-size cap rather than buffering an unbounded response", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(200, 1));
  });
  try {
    await assert.rejects(
      fetchExternalImage(stub.url, { hostCheck: allowLoopback, maxBytes: 50 }),
      /exceeds 50 byte limit/
    );
  } finally {
    await stub.close();
  }
});

test("fetchExternalImage surfaces a non-ok response as an error rather than returning empty bytes", async () => {
  const stub = await withStub((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    await assert.rejects(fetchExternalImage(stub.url, { hostCheck: allowLoopback }), /404/);
  } finally {
    await stub.close();
  }
});
