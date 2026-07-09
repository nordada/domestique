import { promises as fs } from "node:fs";
import { join } from "node:path";
import { handleTorrentDone, type ServerOptions } from "./server.js";

export interface HotfolderConfig {
  /** container path to watch for dropped files/folders */
  dir: string;
  /** where originals get moved after successful processing */
  processedDir: string;
  pollIntervalMs: number;
  stablePolls: number;
}

const PROCESSED_SUBDIR = "processed";

/**
 * Reads HOTFOLDER_* env vars. Returns null (feature disabled) unless
 * HOTFOLDER_DIR is set — same opt-in pattern as plexConfigFromEnv, since
 * this needs a dedicated read-write bind mount (see docker-compose.yml)
 * that isn't present unless the user has deliberately configured it.
 */
/**
 * Parses a positive-integer env var, falling back (with a warning if the
 * value was actually present but invalid) otherwise. Deliberately treats
 * an empty string the same as unset: docker-compose's `${VAR:-}` expands to
 * "" (not an absent var) when VAR isn't set in .env, so a plain `??`
 * fallback would never trigger and `parseInt("", 10)` would silently
 * produce NaN — which is exactly what happened here and made setInterval
 * fire at an effective ~1ms instead of the intended default, hammering the
 * filesystem. Also guards against 0/negative values for the same reason.
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[hotfolder] invalid ${name}="${raw}", falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function hotfolderConfigFromEnv(): HotfolderConfig | null {
  const dir = process.env.HOTFOLDER_DIR;
  if (!dir) return null;

  const pollIntervalMs = parsePositiveIntEnv("HOTFOLDER_POLL_INTERVAL_MS", 60000);
  const stablePolls = parsePositiveIntEnv("HOTFOLDER_STABLE_POLLS", 3);

  return {
    dir,
    processedDir: join(dir, PROCESSED_SUBDIR),
    pollIntervalMs,
    stablePolls,
  };
}

export interface EntryState {
  size: number;
  mtimeMs: number;
  stableCount: number;
}

/**
 * Pure stability check: an entry is "done" once its size/mtime have been
 * unchanged across `requiredStablePolls` consecutive polls. No I/O here so
 * it's trivially unit-testable — all the filesystem/timer plumbing lives in
 * statEntry/pollHotfolder below.
 */
export function updateStability(
  prev: EntryState | undefined,
  current: { size: number; mtimeMs: number },
  requiredStablePolls: number
): { state: EntryState; isStable: boolean } {
  const unchanged = prev !== undefined && prev.size === current.size && prev.mtimeMs === current.mtimeMs;
  const stableCount = unchanged ? prev.stableCount + 1 : 1;
  const state: EntryState = { size: current.size, mtimeMs: current.mtimeMs, stableCount };
  return { state, isStable: stableCount >= requiredStablePolls };
}

/**
 * Stats a top-level watch-folder entry. For a file, its own size/mtime. For
 * a folder, aggregates its immediate file children only (one level deep —
 * matches resolveSourceItems's own assumption that a dropped folder is a
 * flat list of files, not nested), summing size and taking the latest mtime
 * so a still-arriving file anywhere in the folder keeps it "unstable".
 */
async function statEntry(path: string): Promise<{ size: number; mtimeMs: number }> {
  const stat = await fs.stat(path);
  if (stat.isFile()) {
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }

  const entries = await fs.readdir(path, { withFileTypes: true });
  let size = 0;
  let mtimeMs = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const childStat = await fs.stat(join(path, entry.name));
    size += childStat.size;
    if (childStat.mtimeMs > mtimeMs) mtimeMs = childStat.mtimeMs;
  }
  return { size, mtimeMs };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves a processed original into processedDir, same filesystem so this is
 * a cheap atomic rename rather than a copy. Appends a numeric suffix if
 * something with the same name is already there instead of overwriting it.
 */
async function moveToProcessed(name: string, sourcePath: string, processedDir: string): Promise<void> {
  await fs.mkdir(processedDir, { recursive: true });
  let destName = name;
  let suffix = 2;
  while (await pathExists(join(processedDir, destName))) {
    destName = `${name} (${suffix++})`;
  }
  await fs.rename(sourcePath, join(processedDir, destName));
}

/**
 * One poll cycle: lists top-level entries in config.dir (skipping the
 * processed/ subfolder and dotfiles), advances stability tracking for each,
 * and runs newly-stable entries through the exact same pipeline the
 * Transmission webhook uses. `state` is mutated in place and should persist
 * across calls (owned by the caller, e.g. startHotfolderWatcher's closure).
 */
export async function pollHotfolder(
  config: HotfolderConfig,
  opts: ServerOptions,
  state: Map<string, EntryState>
): Promise<void> {
  if (!(await pathExists(config.dir))) return;

  const entries = await fs.readdir(config.dir, { withFileTypes: true });
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.name === PROCESSED_SUBDIR || entry.name.startsWith(".")) continue;
    seen.add(entry.name);

    const entryPath = join(config.dir, entry.name);
    let current: { size: number; mtimeMs: number };
    try {
      current = await statEntry(entryPath);
    } catch (err) {
      // ENOENT here is expected and benign while a multi-file drop is still
      // mid-copy (readdir can list a child file that's renamed/replaced a
      // moment before we stat it) — just skip this poll and let the next
      // one pick it back up, rather than logging a scary warning for what's
      // normal in-progress-copy behavior. Anything else (e.g. permissions)
      // is worth surfacing.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[hotfolder] failed to stat "${entry.name}": ${err}`);
      }
      continue;
    }

    const { state: newState, isStable } = updateStability(state.get(entry.name), current, config.stablePolls);
    state.set(entry.name, newState);
    if (!isStable) continue;

    try {
      console.log(`[hotfolder] "${entry.name}" is stable, processing`);
      await handleTorrentDone({ dir: config.dir, name: entry.name }, opts);
      await moveToProcessed(entry.name, entryPath, config.processedDir);
      state.delete(entry.name);
      console.log(`[hotfolder] "${entry.name}" -> moved to ${PROCESSED_SUBDIR}/`);
    } catch (err) {
      // Left in place (and still tracked in `state`) so it's retried on the
      // next poll. Safe: copyIntoLibrary refuses to overwrite an existing
      // destination, the same idempotency the Transmission webhook already
      // relies on for duplicate/retried fires.
      console.error(`[hotfolder] failed to process "${entry.name}", will retry: ${err}`);
    }
  }

  // Drop tracking for anything that's disappeared from the watch folder
  // (e.g. manually removed) so it doesn't linger in memory forever.
  for (const name of state.keys()) {
    if (!seen.has(name)) state.delete(name);
  }
}

export function startHotfolderWatcher(config: HotfolderConfig, opts: ServerOptions): NodeJS.Timeout {
  const state = new Map<string, EntryState>();
  return setInterval(() => {
    pollHotfolder(config, opts, state).catch((err) => {
      console.error(`[hotfolder] poll cycle failed: ${err}`);
    });
  }, config.pollIntervalMs);
}
