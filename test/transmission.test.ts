import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkTransmissionLive } from "../src/transmission.js";

/**
 * Stubs Transmission's real CSRF handshake: the first request (no session
 * id) gets a 409 with X-Transmission-Session-Id, and only a retry carrying
 * that header back gets a real response.
 */
function startFakeTransmission(expectedAuth: string | null): Promise<{ url: string; close: () => Promise<void> }> {
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "success", arguments: {} }));
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
