import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Ensures a file exists at `path`, seeding it with `produceSeed()`'s content
 * if not. Handles the well-known Docker bind-mount gotcha where mounting a
 * host file that doesn't exist yet onto a container file path silently
 * creates an empty DIRECTORY there instead of a missing path, which would
 * otherwise surface as a confusing EISDIR crash on read.
 * Returns true if it seeded the file, false if one was already there.
 */
export function ensureSeeded(path: string, produceSeed: () => string): boolean {
  let needsSeed = !existsSync(path);
  if (!needsSeed && statSync(path).isDirectory()) {
    if (readdirSync(path).length > 0) {
      throw new Error(`Expected a file at ${path} but found a non-empty directory - check your volume mount.`);
    }
    rmdirSync(path);
    needsSeed = true;
  }

  if (needsSeed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, produceSeed(), "utf-8");
  }
  return needsSeed;
}
