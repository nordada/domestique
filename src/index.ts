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

  // Always started - it re-reads settings on every cycle and cheaply no-ops
  // while hot-folder ingestion is disabled, so enabling/disabling and tuning
  // it live via the web UI takes effect without a restart.
  startHotfolderWatcher(opts);
});
