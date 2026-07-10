import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerOptions, TorrentDonePayload } from "./server.js";

/**
 * The real handleTorrentDone from server.ts, passed in as a parameter rather
 * than imported directly - server.ts already imports handleWebUiRequest from
 * webui.ts, which in turn dispatches upload requests here, so importing
 * handleTorrentDone (a value, not just a type) from server.ts would create a
 * real circular value import. Only `import type` is safe/erased at compile
 * time, hence the plain function parameter instead.
 */
export type ProcessTorrentDone = (payload: TorrentDonePayload, opts: ServerOptions) => Promise<unknown>;

const STAGING_SUBDIR = ".uploads-tmp";

/**
 * A hidden folder under LIBRARY_ROOT rather than the container's own /tmp:
 * on Unraid, Docker's container storage is typically a fixed-size
 * allocation shared across every container, and a few concurrent
 * multi-gigabyte uploads could fill that up and start breaking unrelated
 * containers. LIBRARY_ROOT is already read-write and already sized to hold
 * large video files, since it's the eventual destination anyway. The
 * leading dot follows the same "invisible to Plex" convention already used
 * by fileops.ts's ".archiver-meta.json" sidecar.
 */
function stagingRoot(opts: ServerOptions): string {
  return join(opts.libraryRoot, STAGING_SUBDIR);
}

/**
 * path.basename() plus rejecting empty/"."/".." results - a path-traversal
 * guard for the client-supplied name/folder query params before they ever
 * touch the filesystem.
 */
export function sanitizeName(name: string): string {
  const base = basename(name.trim());
  if (!base || base === "." || base === "..") {
    throw new Error(`invalid name: "${name}"`);
  }
  return base;
}

async function clearIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Streams the request body directly to disk - never buffers it in memory
 * (unlike server.ts's readBody, which is fine for small JSON bodies but
 * would be dangerous for multi-gigabyte video uploads).
 */
async function writeRequestBodyToFile(req: IncomingMessage, destPath: string): Promise<void> {
  await pipeline(req, createWriteStream(destPath));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireQueryParam(url: URL, res: ServerResponse, key: string): string | null {
  const value = url.searchParams.get(key);
  if (!value) {
    sendJson(res, 400, { error: `${key} query param is required` });
    return null;
  }
  return value;
}

/**
 * One-shot single-file upload: streams the body to a staged file, processes
 * it through the same handleTorrentDone the webhook and hot-folder poller
 * use, then deletes the staged copy on success (the real original still
 * lives on the uploader's own machine) or leaves it in place on failure so
 * it can be inspected or retried without re-uploading.
 */
async function handleSingleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  url: URL,
  processTorrentDone: ProcessTorrentDone
): Promise<void> {
  const rawName = requireQueryParam(url, res, "name");
  if (!rawName) return;

  let name: string;
  try {
    name = sanitizeName(rawName);
  } catch (err) {
    sendJson(res, 400, { error: String(err) });
    return;
  }

  const root = stagingRoot(opts);
  await mkdir(root, { recursive: true });
  const destPath = join(root, name);
  await clearIfExists(destPath);

  try {
    await writeRequestBodyToFile(req, destPath);
  } catch (err) {
    sendJson(res, 500, { error: `upload failed: ${err}` });
    return;
  }

  try {
    const results = await processTorrentDone({ dir: root, name }, opts);
    await clearIfExists(destPath);
    sendJson(res, 200, { ok: true, results });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
  }
}

/** Clears any stale leftover from a previous attempt and creates a fresh empty batch folder. */
async function handleFolderStart(res: ServerResponse, opts: ServerOptions, url: URL): Promise<void> {
  const rawFolder = requireQueryParam(url, res, "folder");
  if (!rawFolder) return;

  let folder: string;
  try {
    folder = sanitizeName(rawFolder);
  } catch (err) {
    sendJson(res, 400, { error: String(err) });
    return;
  }

  const folderDir = join(stagingRoot(opts), folder);
  await clearIfExists(folderDir);
  await mkdir(folderDir, { recursive: true });
  sendJson(res, 200, { ok: true });
}

/** Appends one file to an in-progress folder batch. No processing yet. */
async function handleFolderFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  url: URL
): Promise<void> {
  const rawFolder = requireQueryParam(url, res, "folder");
  if (!rawFolder) return;
  const rawName = requireQueryParam(url, res, "name");
  if (!rawName) return;

  let folder: string;
  let name: string;
  try {
    folder = sanitizeName(rawFolder);
    name = sanitizeName(rawName);
  } catch (err) {
    sendJson(res, 400, { error: String(err) });
    return;
  }

  const folderDir = join(stagingRoot(opts), folder);
  await mkdir(folderDir, { recursive: true });
  const destPath = join(folderDir, name);

  try {
    await writeRequestBodyToFile(req, destPath);
  } catch (err) {
    sendJson(res, 500, { error: `upload failed: ${err}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Processes a completed folder batch the same way resolveSourceItems
 * handles any other folder-of-files drop (fileops.ts) - merging the folder
 * name with each file's name via mergeParsed, so a multi-part upload groups
 * into pt01/pt02/etc exactly like a real torrent/hot-folder folder drop.
 */
async function handleFolderFinalize(
  res: ServerResponse,
  opts: ServerOptions,
  url: URL,
  processTorrentDone: ProcessTorrentDone
): Promise<void> {
  const rawFolder = requireQueryParam(url, res, "folder");
  if (!rawFolder) return;

  let folder: string;
  try {
    folder = sanitizeName(rawFolder);
  } catch (err) {
    sendJson(res, 400, { error: String(err) });
    return;
  }

  const root = stagingRoot(opts);
  const folderDir = join(root, folder);

  try {
    const results = await processTorrentDone({ dir: root, name: folder }, opts);
    await clearIfExists(folderDir);
    sendJson(res, 200, { ok: true, results });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
  }
}

/**
 * Handles any /api/upload/* request. Returns false for anything that isn't
 * one of these four routes, so the caller can fall through to its own 404 -
 * same "return true if handled" contract handleWebUiRequest already uses.
 */
export async function handleUploadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  processTorrentDone: ProcessTorrentDone
): Promise<boolean> {
  if (req.method !== "POST") return false;

  const url = new URL(req.url ?? "", "http://internal");

  switch (url.pathname) {
    case "/api/upload/file":
      await handleSingleFileUpload(req, res, opts, url, processTorrentDone);
      return true;
    case "/api/upload/folder-start":
      await handleFolderStart(res, opts, url);
      return true;
    case "/api/upload/folder-file":
      await handleFolderFileUpload(req, res, opts, url);
      return true;
    case "/api/upload/folder-finalize":
      await handleFolderFinalize(res, opts, url, processTorrentDone);
      return true;
    default:
      return false;
  }
}
