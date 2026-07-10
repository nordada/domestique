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

import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Ensures a file exists at `path`, seeding it with `produceSeed()`'s content
 * if not. Handles the well-known Docker bind-mount gotcha where mounting a
 * host file that doesn't exist yet onto a container file path silently
 * creates an empty DIRECTORY there instead of a missing path, which would
 * otherwise surface as a confusing EISDIR crash on read. That directory is
 * usually just an ordinary empty dir we can remove and replace - but if it's
 * the container's actual bind-mount point (the real-world case: nothing
 * existed on the HOST before the container's first boot, so Docker created
 * the directory on the host side too), removing it from inside the
 * container fails with EBUSY, since a mount point can't be unlinked from
 * within its own mount namespace. That needs a host-side fix, so we raise a
 * clear, actionable error instead of the raw EBUSY crash.
 * Returns true if it seeded the file, false if one was already there.
 */
export function ensureSeeded(path: string, produceSeed: () => string): boolean {
  const exists = existsSync(path);
  let needsSeed = !exists;

  if (exists) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (readdirSync(path).length > 0) {
        throw new Error(`Expected a file at ${path} but found a non-empty directory - check your volume mount.`);
      }
      try {
        rmdirSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EBUSY") {
          throw new Error(
            `${path} is an empty directory Docker created because nothing existed on the host at that path before this container's first boot (a well-known bind-mount gotcha) - it can't be removed from inside the container since it's the actual mount point. Fix on the HOST: stop the container, remove/rmdir that path on the host (or create an empty file there instead), then start the container again.`
          );
        }
        throw err;
      }
      needsSeed = true;
    } else if (stat.size === 0) {
      // An existing but empty (0-byte) file - e.g. `touch`ed on the host as
      // a placeholder before first boot specifically to avoid the directory
      // gotcha above - is just as unseeded as a missing path.
      needsSeed = true;
    }
  }

  if (needsSeed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, produceSeed(), "utf-8");
  }
  return needsSeed;
}
