import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkTorrentIntegrity } from "../src/torrentVerify.js";

/** Scriptable fake Transmission RPC server, same shape as dedupe.test.ts's/transmission.test.ts's startFakeTransmissionRpc. */
function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-torrentverify";
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.headers["x-transmission-session-id"] !== sessionId) {
        res.writeHead(409, { "X-Transmission-Session-Id": sessionId });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { method, arguments: args } = JSON.parse(body) as {
          method: string;
          arguments?: Record<string, unknown>;
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "success", arguments: handleMethod(method, args) }));
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

test("checkTorrentIntegrity: a clean verify on a torrent that was running resumes it", async () => {
  const calls: string[] = [];
  const { url, close } = await startFakeTransmissionRpc((method) => {
    calls.push(method);
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 6, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const result = await checkTorrentIntegrity({ url }, 9, false);
    assert.equal(result.clean, true);
    assert.equal(result.percentDone, 1);
    assert.equal(result.resumed, true);
    assert.deepEqual(calls.filter((m) => m === "torrent-stop" || m === "torrent-verify" || m === "torrent-start"), [
      "torrent-stop",
      "torrent-verify",
      "torrent-start",
    ]);
  } finally {
    await close();
  }
});

test("checkTorrentIntegrity: a clean verify on a torrent that was already paused stays paused", async () => {
  const calls: string[] = [];
  const { url, close } = await startFakeTransmissionRpc((method) => {
    calls.push(method);
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 0, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const result = await checkTorrentIntegrity({ url }, 9, true);
    assert.equal(result.clean, true);
    assert.equal(result.resumed, false);
    assert.equal(calls.includes("torrent-start"), false);
  } finally {
    await close();
  }
});

test("checkTorrentIntegrity: a dirty (partial) verify always stays paused, even if the torrent was running before", async () => {
  const calls: string[] = [];
  const { url, close } = await startFakeTransmissionRpc((method) => {
    calls.push(method);
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 6, error: 0, errorString: "", percentDone: 0.42 }] };
    }
    return {};
  });
  try {
    const result = await checkTorrentIntegrity({ url }, 9, false);
    assert.equal(result.clean, false);
    assert.equal(result.percentDone, 0.42);
    assert.equal(result.resumed, false);
    assert.equal(calls.includes("torrent-start"), false);
  } finally {
    await close();
  }
});

test("checkTorrentIntegrity: a verify that comes back with an error is treated as dirty, stays paused", async () => {
  const { url, close } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 0, error: 3, errorString: "Unregistered torrent", percentDone: 1 }] };
    }
    return {};
  });
  try {
    const result = await checkTorrentIntegrity({ url }, 9, false);
    assert.equal(result.clean, false);
    assert.equal(result.error, true);
    assert.equal(result.errorString, "Unregistered torrent");
    assert.equal(result.resumed, false);
  } finally {
    await close();
  }
});

test("checkTorrentIntegrity: always pauses first, regardless of prior state", async () => {
  const calls: string[] = [];
  const { url, close } = await startFakeTransmissionRpc((method) => {
    calls.push(method);
    if (method === "torrent-get") {
      return { torrents: [{ id: 9, status: 0, error: 0, errorString: "", percentDone: 1 }] };
    }
    return {};
  });
  try {
    await checkTorrentIntegrity({ url }, 9, true);
    assert.equal(calls[0], "torrent-stop");
  } finally {
    await close();
  }
});
