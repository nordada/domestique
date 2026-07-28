/**
 * Hand-rolled bencode encoder used only by tests, to build small synthetic
 * .torrent-shaped buffers - there is no production encoder (src/bencode.ts
 * is decode-only, see its own doc comment for why), so this is the one
 * place a test needs to go the other direction. Reused by torrentFile.test.ts
 * and reseed.test.ts (see plan) rather than duplicated per test file.
 */

type EncodableValue = Buffer | string | number | EncodableValue[] | Record<string, EncodableValue>;

export function encodeBencode(value: EncodableValue): Buffer {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === "string") {
    const buf = Buffer.from(value, "utf-8");
    return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
  }
  if (typeof value === "number") {
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map(encodeBencode), Buffer.from("e")]);
  }
  const parts: Buffer[] = [Buffer.from("d")];
  for (const [key, val] of Object.entries(value)) {
    parts.push(encodeBencode(key));
    parts.push(encodeBencode(val));
  }
  parts.push(Buffer.from("e"));
  return Buffer.concat(parts);
}

export function buildSingleFileTorrent(name: string, length: number): Buffer {
  return encodeBencode({
    announce: "http://example.invalid/announce",
    info: { name, length, "piece length": 262144, pieces: "" },
  });
}

export function buildMultiFileTorrent(name: string, files: Array<{ path: string[]; length: number }>): Buffer {
  return encodeBencode({
    announce: "http://example.invalid/announce",
    info: {
      name,
      files: files.map((f) => ({ path: f.path, length: f.length })),
      "piece length": 262144,
      pieces: "",
    },
  });
}

/** A hybrid v1+v2 (BEP 52) torrent - carries "meta version": 2 alongside the ordinary v1 info.length, which is all this parser reads. */
export function buildHybridTorrent(name: string, length: number): Buffer {
  return encodeBencode({
    announce: "http://example.invalid/announce",
    info: { name, length, "piece length": 262144, pieces: "", "meta version": 2 },
  });
}

/** A pure v2-only torrent - no info.length/info.files at all, just BEP 52's "file tree" dict. Should be rejected, not mis-parsed. */
export function buildV2OnlyTorrent(name: string): Buffer {
  return encodeBencode({
    announce: "http://example.invalid/announce",
    info: {
      name,
      "piece length": 262144,
      "meta version": 2,
      "file tree": { "some-file.mp4": { "": { length: 12345 } } },
    },
  });
}
