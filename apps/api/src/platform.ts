import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { createPlatformApp } from './platform/platform-app.js';
import { loadPlatformConfig } from './platform/platform-config.js';
import { shutdownTracing } from './shared/observability/tracing.js';

// Spec 0027 P1, P5: the platform API, a runtime role of the API image beside main.js and worker.js. In development it
// loads .env.console only (the console role's URL, from `pnpm db:setup`), never the repo-root .env, which holds the
// tenant API's databases and secrets: this process refuses to start with any of them (loadPlatformConfig).
const consoleEnv = new URL('../../../.env.console', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(consoleEnv)) process.loadEnvFile(consoleEnv);

const config = loadPlatformConfig();
const app = await createPlatformApp(config, { onShutdown: shutdownTracing });
await app.listen(config.PORT, config.HOST);
new Logger('Platform').log(
  { event: 'platform_api.started', host: config.HOST, port: config.PORT },
  `UniVarse platform API listening on http://${config.HOST}:${String(config.PORT)} (${config.NODE_ENV})`,
);
