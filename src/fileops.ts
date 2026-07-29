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

import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { mergeParsed, parseName, type ParsedName } from "./parser.js";

/**
 * True if `candidate` is `root` itself or somewhere underneath it, resolved
 * against real path segments (via node:path's own relative/resolve) rather
 * than a naive string prefix check, which a sibling directory sharing the
 * same prefix (e.g. `/downloads-evil` vs `/downloads`) would otherwise slip
 * past. Used to keep the webhook's attacker-suppliable `dir`/`name` confined
 * to the actual downloads share; see server.ts's /webhook/torrent-done.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

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
  /** broadcasters archived so far for this episode, first-seen order. broadcasters[0] is the "primary" one, which keeps the clean/untagged filename. */
  broadcasters: string[];
}

type SeasonMeta = Record<string, EpisodeMeta>;

/**
 * Inserts a version tag (e.g. a broadcaster name) into a destination
 * filename, before any "- ptNN" part suffix so multi-part alternate
 * versions still number consistently within themselves:
 *   "Show - S2026E01 - Stage 1 - pt01.mp4" + "Eurosport"
 *   -> "Show - S2026E01 - Stage 1 - Eurosport - pt01.mp4"
 */
function insertVersionTag(filename: string, tag: string): string {
  const ext = extname(filename);
  const base = basename(filename, ext);
  const partMatch = base.match(/^(.*) - (pt\d+)$/);
  if (partMatch) {
    return `${partMatch[1]} - ${tag} - ${partMatch[2]}${ext}`;
  }
  return `${base} - ${tag}${ext}`;
}

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
 * Also tracks the resolution and broadcaster(s) archived per episode in a
 * hidden ".archiver-meta.json" sidecar (never shown in the visible Plex
 * filenames, which stay clean on purpose):
 *
 * - A later release for the same episode at a *lower* resolution than
 *   what's already archived is skipped.
 * - At a *higher* resolution, it's filed alongside the existing file(s)
 *   with a "- REVIEW - possible NNNNp upgrade" tag (inserted before any
 *   part suffix, same as the broadcaster tag below) rather than silently
 *   overwriting anything - nothing is ever auto-deleted.
 * - At the *same* (or unknown) resolution: if this release's broadcaster
 *   (Eurosport/SBS/RCS/etc, from parser.ts) differs from the one(s) already
 *   archived for this episode, it's treated as a genuine alternate version
 *   - filed under its own broadcaster-tagged filename (e.g.
 *   "... - Eurosport - pt01.mp4") so Plex offers it as a selectable
 *   version rather than it colliding with or silently duplicating the
 *   existing one. Multi-part alternates keep their own consistent part
 *   numbering under that same tag. If the broadcaster matches what's
 *   already there (or is unknown on either side), it's treated as a
 *   normal continuation of the same release - e.g. the next part of a
 *   multi-part download still trickling in - and copied under the clean,
 *   untagged filename as usual.
 * - If this episode has no ".archiver-meta.json" entry at all (nothing was
 *   ever copied in through Domestique for it - e.g. a file was placed in
 *   the library some other way before Domestique managed this season) but
 *   the plain filename is already occupied on disk, there's no tracked
 *   "primary" broadcaster to compare against. Rather than assume this new
 *   file is the same release and silently collide with (skip against) the
 *   untracked one, a recognized broadcaster on the new file is enough to
 *   file it as its own tagged alternate instead - see the real incident
 *   this fixed, where NBC alternates for untracked episodes were getting
 *   silently dropped as "destination already exists" instead of archived.
 * - `force` bypasses only the final "destination already exists" skip
 *   above - a deliberate, human-invoked override (the Reseed tab's
 *   "Force file as new version" action) for the case where the heuristics
 *   above conclude "same release, already have it" but a human has
 *   confirmed that's wrong (e.g. same broadcaster tag, but genuinely
 *   different content). Never overwrites: the collision is resolved by
 *   inserting one more version tag, same idea as the upgrade/alternate
 *   paths above, not by replacing what's already there. Deliberately does
 *   NOT bypass the lower-resolution skip earlier in this function - that
 *   one is a meaningful quality signal worth still respecting even when
 *   forcing past a same-broadcaster duplicate.
 */
export async function copyIntoLibrary(
  sourceFile: string,
  libraryRoot: string,
  destDir: string,
  destFilename: string,
  episode: number,
  resolution: number | null,
  broadcaster: string | null,
  force = false
): Promise<CopyOutcome> {
  const destDirAbs = join(libraryRoot, destDir);
  const destPath = join(destDirAbs, destFilename);

  const meta = await loadSeasonMeta(libraryRoot, destDir);
  const key = episodeKey(episode);
  const existing = meta[key];
  const existingBroadcasters = existing?.broadcasters ?? [];

  let finalDestPath = destPath;
  let warning: string | undefined;

  if (existing && existing.resolution != null && resolution != null && resolution < existing.resolution) {
    return {
      status: "skipped",
      destPath,
      reason: `lower resolution (${resolution}p) than the already-archived ${existing.resolution}p for ${key}`,
    };
  }

  const primaryBroadcaster = existingBroadcasters[0];
  // Only worth the extra stat when there's no meta to compare against and
  // this file's own broadcaster is actually known - the one case where an
  // on-disk collision needs to be told apart from "same tracked release".
  const untrackedCollision = !existing && broadcaster != null && (await pathExists(destPath));

  if (existing && existing.resolution != null && resolution != null && resolution > existing.resolution) {
    const reviewName = insertVersionTag(destFilename, `REVIEW - possible ${resolution}p upgrade`);
    finalDestPath = join(destDirAbs, reviewName);
    warning = `Possible upgrade for ${key}: existing archive is ${existing.resolution}p, this is ${resolution}p. Filed alongside as "${reviewName}" - review and delete the old ${existing.resolution}p file(s) by hand if you agree.`;
  } else if (broadcaster && primaryBroadcaster && broadcaster !== primaryBroadcaster) {
    // Every file belonging to this alternate gets the tag (not just its
    // first part), compared against the *primary* (first-ever) broadcaster
    // - not just "have we seen this one before" - so a second part of an
    // already-recognized alternate still gets tagged consistently instead
    // of reverting to the clean/primary filename.
    const altName = insertVersionTag(destFilename, broadcaster);
    finalDestPath = join(destDirAbs, altName);
    if (!existingBroadcasters.includes(broadcaster)) {
      warning = `Filed as an alternate version (${broadcaster}) for ${key} alongside the existing ${primaryBroadcaster} version, as "${altName}".`;
    }
  } else if (untrackedCollision) {
    const altName = insertVersionTag(destFilename, broadcaster!);
    finalDestPath = join(destDirAbs, altName);
    warning = `An untracked file already exists at the plain filename for ${key} (never copied through Domestique, so no version history was recorded for it). Filed this ${broadcaster} release alongside it as "${altName}" instead of treating it as a duplicate - review both files by hand.`;
  }

  // Checked against finalDestPath (not the original destPath) so a repeated
  // upgrade/alternate-version copy is just as idempotent against duplicate
  // webhook fires as the plain case is.
  if (await pathExists(finalDestPath)) {
    if (!force) {
      return { status: "skipped", destPath: finalDestPath, reason: "destination already exists" };
    }
    // Tries "REVIEW - forced", then "REVIEW - forced 2", "REVIEW - forced 3",
    // etc. - a single retry isn't enough for a release with more than one
    // colliding file (e.g. a multi-disc rip where "disc 1"/"disc 2"/"disc 3"
    // all parse to the same untagged identity, since nothing here recognizes
    // "disc N" as a differentiator the way "pt0N"/"Stage N" are): forcing
    // disc 2 claims the plain "REVIEW - forced" slot, so forcing disc 3
    // needs to look one slot further rather than dead-ending on "even the
    // forced filename is taken". Never overwrites regardless - if every
    // attempt up to the cap is also taken, stays safe and skips instead of
    // clobbering the last one found.
    const MAX_FORCE_ATTEMPTS = 20;
    let forcedPath: string | null = null;
    for (let attempt = 1; attempt <= MAX_FORCE_ATTEMPTS; attempt++) {
      const tag = attempt === 1 ? "REVIEW - forced" : `REVIEW - forced ${attempt}`;
      const candidate = join(dirname(finalDestPath), insertVersionTag(basename(finalDestPath), tag));
      if (!(await pathExists(candidate))) {
        forcedPath = candidate;
        break;
      }
    }
    if (!forcedPath) {
      return {
        status: "skipped",
        destPath: finalDestPath,
        reason: `destination already exists (even ${MAX_FORCE_ATTEMPTS} forced-copy filenames are taken)`,
      };
    }
    const forcedName = basename(forcedPath);
    finalDestPath = forcedPath;
    warning = warning
      ? `${warning}; forced past an existing file at the plain destination for ${key}, filed as "${forcedName}" instead - review both files by hand.`
      : `Forced past an existing file at the plain destination for ${key} - filed as "${forcedName}" instead of skipping. Review both files by hand.`;
  }

  await fs.mkdir(destDirAbs, { recursive: true });
  const tmpPath = `${finalDestPath}.tmp`;
  await fs.copyFile(sourceFile, tmpPath);
  await fs.rename(tmpPath, finalDestPath);

  const newBroadcasters =
    broadcaster && !existingBroadcasters.includes(broadcaster)
      ? [...existingBroadcasters, broadcaster]
      : existingBroadcasters;
  const learnedResolution = existing?.resolution == null && resolution != null;

  if (!existing || newBroadcasters.length !== existingBroadcasters.length || learnedResolution) {
    meta[key] = {
      resolution: existing?.resolution ?? resolution,
      broadcasters: newBroadcasters,
    };
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
