import { createApp, optionsFromEnv } from "./server.js";

const opts = optionsFromEnv();
const app = createApp(opts);

app.listen(opts.port, () => {
  console.log(`bike-race-archiver listening on :${opts.port}`);
  console.log(`  library root: ${opts.libraryRoot}`);
  console.log(`  config path:  ${opts.configPath}`);
});
