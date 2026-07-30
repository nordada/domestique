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

// Raw DVD-Video rip structure, per the DVD-Video spec: .BUP/.IFO are
// navigation/backup metadata, never playable video, and VIDEO_TS.VOB (no
// title-set number) is exclusively the disc's menu/intro video - real
// content only ever lives in VTS_NN_MM.VOB (title-set domain). Skipped
// entirely here rather than archived as bogus "episodes" - see the real
// incident this fixed, where VIDEO_TS.BUP/IFO got auto-created into their
// own garbage show ("giro-di-italia-video-ts") instead of being recognized
// as non-content.
const DVD_NAVIGATION_EXTENSIONS = new Set(["bup", "ifo"]);

// A second, unrelated disc-navigation convention seen in the wild: some DVD
// *recorders* (not DVD-Video authoring software) write their own recording-
// management housekeeping into a "VIDEO_RM" folder alongside the real
// VIDEO_TS content - VIDEO_RM.DAT/PVR_TEMP.USR/DVD_REC.USR are exactly this
// (the real incident this fixed: "Giro D'Italia History 1909-1993" carries
// both a VIDEO_TS folder with 3 real VTS_01_N.VOB parts, correctly matched,
// and a VIDEO_RM folder whose 3 junk files permanently counted as
// "unmatched" - a Plex library never contains recorder-metadata files, so
// they could never match anything, same false-partial-match shape as the
// original VIDEO_TS.BUP/IFO case). Matched by exact filename, not a broad
// extension check, since .DAT specifically is also a real video container
// on VCD-format discs (AVSEQ01.DAT etc.) - excluding it by extension alone
// would misclassify genuine video content on a different disc format.
const DVD_RECORDER_NAVIGATION_FILENAMES = new Set(["video_rm.dat", "pvr_temp.usr", "dvd_rec.usr"]);

// A third, much more general category: generic non-video companion files
// scene/private-tracker releases sometimes bundle alongside the real
// content - .nfo/.txt/.sfv/.diz are common release metadata, .srt/.sub/.idx
// subtitles, .jpg/.png/.gif/.bmp cover art or screenshots, .ssp/.par2/.md5
// assorted editing or verification artifacts. None of these can ever have a
// real counterpart in a Plex media library (Plex only ever stores actual
// video files), so counting them the same way as real content produces the
// exact same permanent-false-"Partial match" shape as the two DVD cases
// above - the real incident this fixed: a stray "Project-2.ssp" (a video-
// editing project file, not video itself) sitting in an otherwise-fully-
// filed "Tour-de-France-2019-Stage-17-(ESHD)-Part-2-of-2" torrent. Unlike
// the DVD_RECORDER_NAVIGATION_FILENAMES set above, extension alone is safe
// here - none of these are ever a legitimate video container on any known
// disc/release format, unlike .DAT.
const NON_VIDEO_COMPANION_EXTENSIONS = new Set([
  "nfo",
  "txt",
  "sfv",
  "md5",
  "par2",
  "srt",
  "sub",
  "idx",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "url",
  "ssp",
  "db",
  "m3u",
  "diz",
]);

/**
 * True for a torrent file that's never real video content, whether raw DVD
 * navigation/recorder-metadata or a generic scene-release companion file -
 * see the three constants above for each category's own real incident.
 * Used both at ingest time (resolveSourceItems below, so this never gets
 * auto-created into its own bogus "episode") and by reseedMatch.ts's
 * buildReseedPlan (so it never counts against a torrent's match total
 * either, the same false-partial-match shape every category here produces
 * if left uncounted-for).
 */
export function isNonContentFile(filename: string): boolean {
  const ext = extname(filename).slice(1).toLowerCase();
  if (DVD_NAVIGATION_EXTENSIONS.has(ext)) return true;
  if (NON_VIDEO_COMPANION_EXTENSIONS.has(ext)) return true;
  if (DVD_RECORDER_NAVIGATION_FILENAMES.has(filename.toLowerCase())) return true;
  return /^video_ts\.vob$/i.test(filename);
}

// Folder names never worth recursing into - real incident this guards
// against: a naive general-recursive walk (see resolveSourceItems below)
// would otherwise vacuum up a low-quality preview clip sitting in a
// "Sample" folder, or a screenshot in "Proof", as if it were real episode
// content. Exact (case-insensitive) name match, not a substring test - a
// real release folder like "1999.Giro.d'Italia.WCP.VHS.rip" doesn't
// collide with any of these.
const JUNK_FOLDER_NAMES = new Set(["sample", "samples", "extra", "extras", "subs", "subtitles", "screens", "screenshots", "proof"]);

// Safety net against a pathological/adversarial directory tree, not a
// limit expected to ever actually bind on a real release - nothing
// evidenced in this app's real usage nests anywhere close to this deep.
const MAX_WALK_DEPTH = 8;

interface WalkedFile {
  name: string;
  dir: string;
  /** Subfolder names from the torrent's own top-level folder down to this file's immediate parent, root-first - see resolveSourceItems' doc comment on how these fold into parsing. */
  ancestorNames: string[];
}

async function walkForFiles(dir: string, ancestorNames: string[], depth: number): Promise<WalkedFile[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: WalkedFile[] = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, dir, ancestorNames }));
  for (const entry of entries) {
    if (!entry.isDirectory() || JUNK_FOLDER_NAMES.has(entry.name.toLowerCase())) continue;
    files.push(...(await walkForFiles(join(dir, entry.name), [...ancestorNames, entry.name], depth + 1)));
  }
  return files;
}

/**
 * Given the directory Transmission downloaded into and the torrent's name,
 * figures out whether it's a single file or a folder of files, and returns
 * one SourceItem per file to archive. For folders, each file is parsed by
 * merging its own name with every ancestor subfolder's name plus the
 * torrent's own top-level name (see parser.mergeParsed), root-to-leaf, most
 * specific (the file's own name) always winning - since part/stage/year
 * info can live on any of those, not just the immediate filename (a real
 * incident this fixed: "Giro di Italia/Giro di Italia 1999/1999...WCP.VHS.
 * rip/1999...Tape.1.avi" needs its year from the middle folder names, not
 * the top-level torrent name alone). A genuine recursive walk (capped at
 * MAX_WALK_DEPTH, skipping known-junk folder names like "Sample" - see
 * above) rather than the single-level-plus-one-special-cased-"VIDEO_TS"-
 * folder scan this used to be: real content in the wild routinely sits
 * nested under arbitrarily-named subfolders (year folders, per-disc
 * release folders), not just that one DVD-spec-defined name. Non-content
 * files (see isNonContentFile - DVD navigation/recorder metadata, generic
 * scene-release companion files) are skipped entirely, never even reaching
 * the parser, regardless of which folder they're found in.
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
  const fileEntries = await walkForFiles(topLevelPath, [], 0);

  const items: SourceItem[] = [];
  for (const { name, dir, ancestorNames } of fileEntries) {
    if (isNonContentFile(name)) continue;
    const ext = extname(name).slice(1).toLowerCase() || VIDEO_EXT_FALLBACK;
    const nameNoExt = basename(name, extname(name));

    let parsed = folderParsed;
    for (const ancestorName of ancestorNames) {
      parsed = mergeParsed(parsed, parseName(ancestorName));
    }
    parsed = mergeParsed(parsed, parseName(nameNoExt));

    items.push({ sourceFile: join(dir, name), parsed, ext });
  }
  return items;
}

export type CopyOutcome =
  | { status: "copied"; destPath: string; warning?: string; method: "hardlink" | "copy" }
  | { status: "skipped"; destPath: string; reason: string };

function isExdev(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EXDEV";
}

/** Narrow dependency-injection seam, same idiom as reseedStage.ts's StageDeps - exists only so the EXDEV fallback (unreproducible on a real single-filesystem CI box) can be exercised in a test. Every real caller omits this. */
export interface CopyIntoLibraryDeps {
  link?: typeof fs.link;
}

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
  force = false,
  fileMode: "copy" | "hardlink" = "copy",
  deps: CopyIntoLibraryDeps = {}
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
  const doLink = deps.link ?? fs.link;
  let method: "hardlink" | "copy" = "copy";
  if (fileMode === "hardlink") {
    try {
      await doLink(sourceFile, finalDestPath);
      method = "hardlink";
    } catch (err) {
      if (!isExdev(err)) throw err;
      // Cross-filesystem (downloads share and library on separate disks/
      // pools) - fall back to a real copy, same as reseedStage.ts's
      // identical constraint. The caller (server.ts) surfaces this in its
      // summary when it happens, so choosing hardlink mode and silently
      // getting full-duplicate behavior anyway is never invisible.
    }
  }
  if (method === "copy") {
    const tmpPath = `${finalDestPath}.tmp`;
    await fs.copyFile(sourceFile, tmpPath);
    await fs.rename(tmpPath, finalDestPath);
  }

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
    ? { status: "copied", destPath: finalDestPath, warning, method }
    : { status: "copied", destPath: finalDestPath, method };
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
