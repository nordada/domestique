import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, assertPublicHostname } from "../src/ssrfGuard.js";

test("isBlockedIp rejects IPv4 loopback, RFC1918 private ranges, and link-local (incl. cloud metadata)", () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.0.0.5"), true);
  assert.equal(isBlockedIp("172.16.0.1"), true);
  assert.equal(isBlockedIp("172.31.255.255"), true);
  assert.equal(isBlockedIp("192.168.1.24"), true); // this project's own TOWER LAN IP, notably
  assert.equal(isBlockedIp("169.254.169.254"), true); // the classic cloud-metadata address
  assert.equal(isBlockedIp("100.64.0.1"), true); // CGNAT
});

test("isBlockedIp allows ordinary public IPv4 addresses", () => {
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("1.1.1.1"), false);
  assert.equal(isBlockedIp("93.184.216.34"), false);
});

test("isBlockedIp correctly respects range boundaries, not just prefix-string matching", () => {
  // 172.16.0.0/12 covers 172.16.0.0-172.31.255.255 - 172.32.x.x and 172.15.x.x are outside it and must NOT be blocked.
  assert.equal(isBlockedIp("172.32.0.1"), false);
  assert.equal(isBlockedIp("172.15.0.1"), false);
  // 192.168.0.0/16 - 192.169.x.x is outside it.
  assert.equal(isBlockedIp("192.169.0.1"), false);
});

test("isBlockedIp rejects IPv6 loopback, unique-local, link-local, and multicast", () => {
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("fc00::1"), true);
  assert.equal(isBlockedIp("fe80::1"), true);
  assert.equal(isBlockedIp("ff02::1"), true);
});

test("isBlockedIp allows an ordinary public IPv6 address", () => {
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false); // Cloudflare's public resolver
});

test("isBlockedIp checks the embedded address in an IPv4-mapped IPv6 literal", () => {
  assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIp("::ffff:8.8.8.8"), false);
});

test("isBlockedIp fails closed on something that isn't a recognizable IP at all", () => {
  assert.equal(isBlockedIp("not-an-ip"), true);
});

test("assertPublicHostname rejects a literal private/loopback IP address directly, with no DNS lookup needed", async () => {
  await assert.rejects(assertPublicHostname("192.168.1.24"), /refusing to fetch/);
  await assert.rejects(assertPublicHostname("127.0.0.1"), /refusing to fetch/);
});

test("assertPublicHostname resolves and allows a real public hostname", async () => {
  // A hostname that's stable and always resolves to a public address -
  // acceptable to rely on for this one test since it's exercising the real
  // DNS-resolution code path itself, not something mockable without
  // reaching further into Node's own dns module than is reasonable here.
  await assert.doesNotReject(assertPublicHostname("commons.wikimedia.org"));
});

test("assertPublicHostname throws for a hostname that doesn't resolve at all", async () => {
  await assert.rejects(
    assertPublicHostname("this-domain-should-never-exist-domestique-test.invalid"),
    /could not resolve|ENOTFOUND/
  );
});
