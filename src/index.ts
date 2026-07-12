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

import { createApp, optionsFromEnv } from "./server.js";
import { startHotfolderWatcher } from "./hotfolder.js";
import { loadSettings } from "./settings.js";

const opts = optionsFromEnv();
const app = createApp(opts);

app.listen(opts.port, () => {
  console.log(`domestique listening on :${opts.port}`);
  console.log(`  library root: ${opts.libraryRoot}`);
  console.log(`  config path:  ${opts.configPath}`);
  console.log(`  settings path: ${opts.settingsPath}`);

  const settings = loadSettings(opts.settingsPath, opts.libraryRoot);
  console.log(
    settings.plex
      ? `  plex refresh: enabled (section ${settings.plex.sectionId} at ${settings.plex.url})`
      : `  plex refresh: disabled (set via the web UI, or PLEX_URL/PLEX_TOKEN/PLEX_SECTION_ID before first boot)`
  );
  console.log(
    settings.discord
      ? `  discord:      enabled${settings.discord.mentionUserId ? ` (mentions <@${settings.discord.mentionUserId}> on review-worthy events)` : " (no mention user set)"}`
      : `  discord:      disabled (set via the web UI, or DISCORD_WEBHOOK_URL before first boot)`
  );
  console.log(
    opts.webui
      ? `  web ui:       enabled (http://localhost:${opts.port}/ui)`
      : `  web ui:       disabled (set WEBUI_PASSWORD to enable)`
  );
  console.log(
    settings.hotfolder
      ? `  hot folder:   enabled (watching ${settings.hotfolder.dir}, ${settings.hotfolder.pollIntervalMs}ms / ${settings.hotfolder.stablePolls} stable polls)`
      : `  hot folder:   disabled (set via the web UI, or HOTFOLDER_DIR before first boot)`
  );
  // Deliberately loud: the app can't detect whether it's actually exposed
  // past the LAN, so it can't enforce a secret, but anyone reading the
  // startup log should see the open webhook called out.
  if (!settings.webhookSecret) {
    console.warn(
      `  WARNING: /webhook/torrent-done has no shared secret configured. Fine on a trusted LAN; if this app is reachable from the internet, set one in the web UI's Settings tab and in torrent-done.env.`
    );
  }

  // Always started - it re-reads settings on every cycle and cheaply no-ops
  // while hot-folder ingestion is disabled, so enabling/disabling and tuning
  // it live via the web UI takes effect without a restart.
  startHotfolderWatcher(opts);
});
