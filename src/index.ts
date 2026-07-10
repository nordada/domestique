import { createApp, optionsFromEnv } from "./server.js";
import { hotfolderConfigFromEnv, startHotfolderWatcher } from "./hotfolder.js";

const opts = optionsFromEnv();
const app = createApp(opts);

app.listen(opts.port, () => {
  console.log(`domestique listening on :${opts.port}`);
  console.log(`  library root: ${opts.libraryRoot}`);
  console.log(`  config path:  ${opts.configPath}`);
  console.log(
    opts.plex
      ? `  plex refresh: enabled (section ${opts.plex.sectionId} at ${opts.plex.url})`
      : `  plex refresh: disabled (set PLEX_URL/PLEX_TOKEN/PLEX_SECTION_ID to enable)`
  );
  console.log(
    opts.discord
      ? `  discord:      enabled${opts.discord.mentionUserId ? ` (mentions <@${opts.discord.mentionUserId}> on review-worthy events)` : " (no mention user set)"}`
      : `  discord:      disabled (set DISCORD_WEBHOOK_URL to enable)`
  );

  const hotfolder = hotfolderConfigFromEnv();
  if (hotfolder) {
    startHotfolderWatcher(hotfolder, opts);
    console.log(
      `  hot folder:   enabled (watching ${hotfolder.dir}, ${hotfolder.pollIntervalMs}ms / ${hotfolder.stablePolls} stable polls)`
    );
  } else {
    console.log(`  hot folder:   disabled (set HOTFOLDER_DIR to enable)`);
  }
});
