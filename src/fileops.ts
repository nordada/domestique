import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { mergeParsed, parseName, type ParsedName } from "./parser.js";

export interface SourceItem {
  /** absolute path to the actual media file to copy */
  sourceFile: string;
  parsed: ParsedName;
  ext: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

const VIDEO_EXT_FALLBACK = "mp4";

/**
 * Given the directory Transmission downloaded into and the torrent's name,
 * figures out whether it's a single file or a folder of files, and returns
 * one SourceItem per file to archive. For folders, each file is parsed using
 * its own name merged with the folder's name (see parser.mergeParsed) since
 * part/stage info lives on the individual filenames in this library.
 */
export async function resolveSourceItems(
  torrentDir: string,
  torrentName: string
): Promise<SourceItem[]> {
  const topLevelPath = join(torrentDir, torrentName);
  const stat = await fs.stat(topLevelPath);

  if (stat.isFile()) {
    const ext = extname(topLevelPath).slice(1).toLowerCase() || VIDEO_EXT_FALLBACK;
    const nameNoExt = basename(topLevelPath, extname(topLevelPath));
    return [{ sourceFile: topLevelPath, parsed: parseName(nameNoExt), ext }];
  }

  const folderParsed = parseName(torrentName);
  const entries = await fs.readdir(topLevelPath, { withFileTypes: true });
  const items: SourceItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).slice(1).toLowerCase() || VIDEO_EXT_FALLBACK;
    const nameNoExt = basename(entry.name, extname(entry.name));
    const fileParsed = parseName(nameNoExt);
    items.push({
      sourceFile: join(topLevelPath, entry.name),
      parsed: mergeParsed(folderParsed, fileParsed),
      ext,
    });
  }
  return items;
}

export type CopyOutcome =
  | { status: "copied"; destPath: string; warning?: string }
  | { status: "skipped"; destPath: string; reason: string };

const META_FILENAME = ".archiver-meta.json";

interface EpisodeMeta {
  resolution: number | null;
}

type SeasonMeta = Record<string, EpisodeMeta>;

function episodeKey(episode: number): string {
  return `E${String(episode).padStart(2, "0")}`;
}

async function loadSeasonMeta(libraryRoot: string, destDir: string): Promise<SeasonMeta> {
  const metaPath = join(libraryRoot, destDir, META_FILENAME);
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    return JSON.parse(raw) as SeasonMeta;
  } catch {
    return {};
  }
}

async function saveSeasonMeta(
  libraryRoot: string,
  destDir: string,
  meta: SeasonMeta
): Promise<void> {
  const metaPath = join(libraryRoot, destDir, META_FILENAME);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

/**
 * Copies sourceFile into libraryRoot/destDir/destFilename, creating destDir
 * as needed. Copies to a ".tmp" sibling first and renames into place so
 * Plex never sees a partially-written file. Refuses to overwrite an existing
 * destination (safe against duplicate webhook fires from Transmission).
 *
 * Also tracks the resolution archived per episode in a hidden
 * ".archiver-meta.json" sidecar (never shown in the visible Plex filenames,
 * which stay clean on purpose). If a later release for the same episode
 * arrives at a *lower* resolution than what's already archived, it's
 * skipped. At a *higher* resolution, it's filed alongside the existing
 * file(s) with a "(REVIEW - possible NNNNp upgrade)" suffix rather than
 * silently overwriting anything — nothing is ever auto-deleted. Equal or
 * unknown resolution (on either side) is treated as a normal same-episode
 * continuation (e.g. the next part of a multi-part release) and copied
 * normally.
 */
export async function copyIntoLibrary(
  sourceFile: string,
  libraryRoot: string,
  destDir: string,
  destFilename: string,
  episode: number,
  resolution: number | null
): Promise<CopyOutcome> {
  const destDirAbs = join(libraryRoot, destDir);
  const destPath = join(destDirAbs, destFilename);

  const meta = await loadSeasonMeta(libraryRoot, destDir);
  const key = episodeKey(episode);
  const existing = meta[key];

  let finalDestPath = destPath;
  let warning: string | undefined;

  if (existing && existing.resolution != null && resolution != null) {
    if (resolution < existing.resolution) {
      return {
        status: "skipped",
        destPath,
        reason: `lower resolution (${resolution}p) than the already-archived ${existing.resolution}p for ${key}`,
      };
    }
    if (resolution > existing.resolution) {
      const ext = extname(destFilename);
      const base = basename(destFilename, ext);
      const reviewName = `${base} (REVIEW - possible ${resolution}p upgrade)${ext}`;
      finalDestPath = join(destDirAbs, reviewName);
      warning = `Possible upgrade for ${key}: existing archive is ${existing.resolution}p, this is ${resolution}p. Filed alongside as "${reviewName}" — review and delete the old ${existing.resolution}p file(s) by hand if you agree.`;
    }
  }

  // Checked against finalDestPath (not the original destPath) so a repeated
  // upgrade-review copy is just as idempotent against duplicate webhook
  // fires as the plain case is.
  if (await pathExists(finalDestPath)) {
    return { status: "skipped", destPath: finalDestPath, reason: "destination already exists" };
  }

  await fs.mkdir(destDirAbs, { recursive: true });
  const tmpPath = `${finalDestPath}.tmp`;
  await fs.copyFile(sourceFile, tmpPath);
  await fs.rename(tmpPath, finalDestPath);

  if (resolution != null && (!existing || existing.resolution == null)) {
    meta[key] = { resolution };
    await saveSeasonMeta(libraryRoot, destDir, meta);
  }

  return warning
    ? { status: "copied", destPath: finalDestPath, warning }
    : { status: "copied", destPath: finalDestPath };
}

/**
 * Assigns episode numbers for multi-category-dynamic shows (and fixed-table
 * fallback) by scanning what's already in the season folder: reuse the same
 * episode number for a title already seen there, otherwise the next integer
 * after the current max.
 */
export async function resolveDynamicEpisode(
  libraryRoot: string,
  destDir: string,
  title: string
): Promise<number> {
  const dirAbs = join(libraryRoot, destDir);
  if (!(await pathExists(dirAbs))) return 1;

  const entries = await fs.readdir(dirAbs);
  let maxEpisode = 0;
  for (const entry of entries) {
    const m = entry.match(/E(\d+)\s*-\s*(.+?)(?:\s*-\s*pt\d+)?\.[a-z0-9]+$/i);
    if (!m) continue;
    const episode = parseInt(m[1], 10);
    const existingTitle = m[2].trim();
    if (existingTitle.toLowerCase() === title.toLowerCase()) {
      return episode;
    }
    if (episode > maxEpisode) maxEpisode = episode;
  }
  return maxEpisode + 1;
}
