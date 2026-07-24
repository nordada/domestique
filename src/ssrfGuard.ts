/**
 * Domestique - files completed bike-race torrent downloads into a Plex-friendly library layout.
 * Copyright (C) 2026  @nordada AKA Chris Reynolds
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { isIPv4, isIPv6 } from "node:net";
import { lookup } from "node:dns/promises";

// [network, prefix] pairs for IPv4 ranges that must never be reachable from
// a pasted "fetch this image" URL: loopback, RFC1918 private space, the
// link-local block (this is where cloud metadata endpoints like
// 169.254.169.254 live), CGNAT, documentation/benchmarking ranges,
// multicast, and reserved/broadcast.
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const target = v4ToInt(ip);
  return BLOCKED_V4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (target & mask) === (v4ToInt(network) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7, unique local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10, link-local
  if (lower.startsWith("ff")) return true; // ff00::/8, multicast
  // IPv4-mapped (::ffff:a.b.c.d) - check the embedded v4 address too, since
  // an attacker could hand this form to reach a blocked v4 target.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isBlockedV4(mapped[1])) return true;
  return false;
}

/** True if this literal IP address is loopback/private/link-local/reserved and must not be fetched from. */
export function isBlockedIp(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedV4(ip);
  if (isIPv6(ip)) return isBlockedV6(ip);
  return true; // not a recognizable IP at all - fail closed
}

/**
 * Resolves `hostname` and throws if ANY resolved address is
 * loopback/private/link-local/reserved - the guard a general "fetch this
 * URL the user pasted in" feature needs before it can be trusted not to
 * probe the host's own LAN, other Docker containers, or a cloud metadata
 * endpoint.
 *
 * Known, deliberate limitation: this checks DNS at request time, then the
 * actual fetch resolves the same hostname again independently - a
 * malicious DNS server could answer differently between the two lookups
 * (DNS rebinding) and slip a private address past this check. Closing that
 * fully would mean pinning the connection to the exact validated IP (a
 * custom fetch dispatcher), which is more machinery than this self-hosted,
 * Basic-Auth-gated admin feature warrants - this stops the realistic cases
 * (someone pasting an internal IP or hostname outright, or a link-local
 * metadata address), not a determined DNS-rebinding attacker.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error(`refusing to fetch a private/reserved address: ${hostname}`);
    }
    return;
  }
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`could not resolve hostname: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`refusing to fetch "${hostname}" - resolves to a private/reserved address (${address})`);
    }
  }
}
