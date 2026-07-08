import { createApp, optionsFromEnv } from "./server.js";

const opts = optionsFromEnv();
const app = createApp(opts);

app.listen(opts.port, () => {
  console.log(`bike-race-archiver listening on :${opts.port}`);
  console.log(`  library root: ${opts.libraryRoot}`);
  console.log(`  config path:  ${opts.configPath}`);
  console.log(
    opts.plex
      ? `  plex refresh: enabled (section ${opts.plex.sectionId} at ${opts.plex.url})`
      : `  plex refresh: disabled (set PLEX_URL/PLEX_TOKEN/PLEX_SECTION_ID to enable)`
  );
});
