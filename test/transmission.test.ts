import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  checkTransmissionLive,
  getTransmissionTorrentSummary,
  addTorrentToTransmission,
  pollTorrentAdded,
  transmissionWebUrl,
} from "../src/transmission.js";

test("transmissionWebUrl derives the web UI path from the RPC URL's own host/port, ignoring its path", () => {
  assert.equal(
    transmissionWebUrl({ url: "http://192.168.1.24:9091/transmission/rpc" }),
    "http://192.168.1.24:9091/transmission/web/"
  );
  // A reverse-proxied or otherwise nonstandard RPC path shouldn't change the result - only the origin matters.
  assert.equal(
    transmissionWebUrl({ url: "http://192.168.1.24:9091/some/other/rpc/path" }),
    "http://192.168.1.24:9091/transmission/web/"
  );
});

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

/**
 * A more general fake Transmission than startFakeTransmission above - lets
 * each test script how the server responds per RPC method, needed to
 * exercise torrent-add and to simulate torrent-get returning empty on early
 * poll attempts before the torrent "shows up".
 */
function startFakeTransmissionRpc(
  handleMethod: (method: string, args: Record<string, unknown> | undefined) => Record<string, unknown>
): Promise<{ url: string; close: () => Promise<void> }> {
  const sessionId = "fake-session-id-789";
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

test("addTorrentToTransmission sends the base64 metainfo and returns the added torrent", async () => {
  let receivedMetainfo: unknown;
  const { url, close } = await startFakeTransmissionRpc((method, args) => {
    if (method === "torrent-add") {
      receivedMetainfo = args?.metainfo;
      return { "torrent-added": { id: 7, name: "Tour de France Stage 5", hashString: "abc123" } };
    }
    return {};
  });
  try {
    const result = await addTorrentToTransmission({ url }, Buffer.from("fake torrent bytes").toString("base64"));
    assert.deepEqual(result, { id: 7, name: "Tour de France Stage 5", hashString: "abc123", duplicate: false });
    assert.equal(receivedMetainfo, Buffer.from("fake torrent bytes").toString("base64"));
  } finally {
    await close();
  }
});

test("addTorrentToTransmission reports duplicate:true for an already-added torrent", async () => {
  const { url, close } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-add") {
      return { "torrent-duplicate": { id: 3, name: "Paris-Roubaix", hashString: "dup456" } };
    }
    return {};
  });
  try {
    const result = await addTorrentToTransmission({ url }, "irrelevant-base64");
    assert.deepEqual(result, { id: 3, name: "Paris-Roubaix", hashString: "dup456", duplicate: true });
  } finally {
    await close();
  }
});

test("addTorrentToTransmission throws when the response has neither torrent-added nor torrent-duplicate", async () => {
  const { url, close } = await startFakeTransmissionRpc(() => ({}));
  try {
    await assert.rejects(() => addTorrentToTransmission({ url }, "irrelevant-base64"));
  } finally {
    await close();
  }
});

test("pollTorrentAdded returns the torrent as soon as torrent-get reports it", async () => {
  const { url, close } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      return { torrents: [{ id: 7, status: 4, error: 0, errorString: "" }] };
    }
    return {};
  });
  try {
    const result = await pollTorrentAdded({ url }, 7, { attempts: 3, intervalMs: 10 });
    assert.deepEqual(result, { id: 7, status: 4, error: 0, errorString: "" });
  } finally {
    await close();
  }
});

test("pollTorrentAdded retries until the torrent shows up, then returns it", async () => {
  let calls = 0;
  const { url, close } = await startFakeTransmissionRpc((method) => {
    if (method === "torrent-get") {
      calls += 1;
      return { torrents: calls < 3 ? [] : [{ id: 9, status: 6, error: 0, errorString: "" }] };
    }
    return {};
  });
  try {
    const result = await pollTorrentAdded({ url }, 9, { attempts: 5, intervalMs: 10 });
    assert.deepEqual(result, { id: 9, status: 6, error: 0, errorString: "" });
    assert.equal(calls, 3);
  } finally {
    await close();
  }
});

test("pollTorrentAdded gives up and returns null once attempts run out", async () => {
  const { url, close } = await startFakeTransmissionRpc((method) => (method === "torrent-get" ? { torrents: [] } : {}));
  try {
    const result = await pollTorrentAdded({ url }, 42, { attempts: 3, intervalMs: 10 });
    assert.equal(result, null);
  } finally {
    await close();
  }
});
