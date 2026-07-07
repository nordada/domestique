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
  | { status: "copied"; destPath: string }
  | { status: "skipped"; destPath: string; reason: string };

/**
 * Copies sourceFile into libraryRoot/destDir/destFilename, creating destDir
 * as needed. Copies to a ".tmp" sibling first and renames into place so
 * Plex never sees a partially-written file. Refuses to overwrite an existing
 * destination (safe against duplicate webhook fires from Transmission).
 */
export async function copyIntoLibrary(
  sourceFile: string,
  libraryRoot: string,
  destDir: string,
  destFilename: string
): Promise<CopyOutcome> {
  const destDirAbs = join(libraryRoot, destDir);
  const destPath = join(destDirAbs, destFilename);

  if (await pathExists(destPath)) {
    return { status: "skipped", destPath, reason: "destination already exists" };
  }

  await fs.mkdir(destDirAbs, { recursive: true });
  const tmpPath = `${destPath}.tmp`;
  await fs.copyFile(sourceFile, tmpPath);
  await fs.rename(tmpPath, destPath);
  return { status: "copied", destPath };
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
