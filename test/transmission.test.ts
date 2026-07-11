import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkTransmissionLive, getTransmissionTorrentSummary } from "../src/transmission.js";

/**
 * Stubs Transmission's real CSRF handshake: the first request (no session
 * id) gets a 409 with X-Transmission-Session-Id, and only a retry carrying
 * that header back gets a real response. `torrents`, if given, is echoed
 * back as the `arguments.torrents` of a torrent-get response - session-get
 * always gets empty arguments, same as the real RPC.
 */
function startFakeTransmission(
  expectedAuth: string | null,
  torrents: Array<{ status: number; error: number }> = []
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-123";
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (expectedAuth && req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.headers["x-transmission-session-id"] !== sessionId) {
        res.writeHead(409, { "X-Transmission-Session-Id": sessionId });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { method } = JSON.parse(body) as { method: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            result: "success",
            arguments: method === "torrent-get" ? { torrents } : {},
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/transmission/rpc`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("checkTransmissionLive completes the session-id handshake and reports true", async () => {
  const { url, close } = await startFakeTransmission(null);
  try {
    assert.equal(await checkTransmissionLive({ url }), true);
  } finally {
    await close();
  }
});

test("checkTransmissionLive sends HTTP Basic auth when credentials are configured", async () => {
  const expected = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;
  const { url, close } = await startFakeTransmission(expected);
  try {
    assert.equal(await checkTransmissionLive({ url, username: "admin", password: "hunter2" }), true);
    assert.equal(await checkTransmissionLive({ url, username: "admin", password: "wrong" }), false);
  } finally {
    await close();
  }
});

test("checkTransmissionLive returns false when nothing is listening", async () => {
  assert.equal(await checkTransmissionLive({ url: "http://127.0.0.1:1" }, 500), false);
});

test("getTransmissionTorrentSummary reports hasError when any torrent has a tracker/local error", async () => {
  const { url, close } = await startFakeTransmission(null, [
    { status: 6, error: 0 }, // seeding, clean
    { status: 6, error: 3 }, // seeding, local error
  ]);
  try {
    assert.deepEqual(await getTransmissionTorrentSummary({ url }), {
      total: 2,
      hasError: true,
      downloading: false,
    });
  } finally {
    await close();
  }
});

test("getTransmissionTorrentSummary reports downloading when a torrent is queued-to-download or downloading, and no errors", async () => {
  const { url, close } = await startFakeTransmission(null, [
    { status: 6, error: 0 }, // seeding
    { status: 4, error: 0 }, // downloading
  ]);
  try {
    assert.deepEqual(await getTransmissionTorrentSummary({ url }), {
      total: 2,
      hasError: false,
      downloading: true,
    });
  } finally {
    await close();
  }
});

test("getTransmissionTorrentSummary reports neither error nor downloading when everything is idle/seeding clean", async () => {
  const { url, close } = await startFakeTransmission(null, [{ status: 6, error: 0 }]);
  try {
    assert.deepEqual(await getTransmissionTorrentSummary({ url }), {
      total: 1,
      hasError: false,
      downloading: false,
    });
  } finally {
    await close();
  }
});

test("getTransmissionTorrentSummary returns null when nothing is listening", async () => {
  assert.equal(await getTransmissionTorrentSummary({ url: "http://127.0.0.1:1" }, 500), null);
});
