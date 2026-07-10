import { test } from "node:test";
import assert from "node:assert/strict";
import { discordConfigFromEnv, sendDiscordNotification } from "../src/discord.js";

test("discordConfigFromEnv returns null unless DISCORD_WEBHOOK_URL is set", () => {
  const saved = {
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    DISCORD_MENTION_USER_ID: process.env.DISCORD_MENTION_USER_ID,
  };
  try {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_MENTION_USER_ID;
    assert.equal(discordConfigFromEnv(), null);

    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
    const config = discordConfigFromEnv();
    assert.ok(config);
    assert.equal(config?.webhookUrl, "https://discord.com/api/webhooks/123/abc");
    assert.equal(config?.mentionUserId, undefined);

    process.env.DISCORD_MENTION_USER_ID = "999888777";
    const config2 = discordConfigFromEnv();
    assert.equal(config2?.mentionUserId, "999888777");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sendDiscordNotification posts plain content and suppresses mentions when mention isn't requested", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    await sendDiscordNotification(
      { webhookUrl: "https://discord.com/api/webhooks/123/abc", mentionUserId: "555" },
      "everything is fine"
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.com/api/webhooks/123/abc");
    assert.equal(calls[0].body.content, "everything is fine");
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendDiscordNotification prefixes and whitelists a mention when requested and configured", async () => {
  const calls: Array<{ body: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    await sendDiscordNotification(
      { webhookUrl: "https://discord.com/api/webhooks/123/abc", mentionUserId: "555" },
      "needs review",
      { mention: true }
    );
    assert.equal(calls[0].body.content, "<@555> needs review");
    assert.deepEqual(calls[0].body.allowed_mentions, { users: ["555"] });
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendDiscordNotification skips the mention prefix when review-worthy but no mention user is configured", async () => {
  const calls: Array<{ body: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    await sendDiscordNotification(
      { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      "needs review",
      { mention: true }
    );
    assert.equal(calls[0].body.content, "needs review");
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendDiscordNotification throws when the webhook responds with a non-ok status", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, status: 404, statusText: "Not Found" }) as Response) as typeof fetch;

  try {
    await assert.rejects(
      () => sendDiscordNotification({ webhookUrl: "https://discord.com/api/webhooks/123/abc" }, "hi"),
      /Discord webhook returned 404/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendDiscordNotification truncates content over Discord's length limit", async () => {
  const calls: Array<{ body: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    const longMessage = "x".repeat(3000);
    await sendDiscordNotification({ webhookUrl: "https://discord.com/api/webhooks/123/abc" }, longMessage);
    assert.ok(calls[0].body.content.length < 2000);
    assert.ok(calls[0].body.content.endsWith("… (truncated)"));
  } finally {
    global.fetch = originalFetch;
  }
});
