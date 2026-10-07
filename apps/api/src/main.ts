import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';
import { shutdownTracing } from './shared/observability/tracing.js';

// Local dev convenience: repo-root .env. In deployed environments, env comes from the secret manager.
const rootEnv = new URL('../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig();
// OB11: on SIGTERM/SIGINT Nest closes the app, and the last shutdown hook flushes traces (bounded).
const app = await createApp(config, { onShutdown: shutdownTracing });
await app.listen(config.PORT, config.HOST);
new Logger('Main').log({ event: 'api.started', host: config.HOST, port: config.PORT }, `UniVarse API listening on http://${config.HOST}:${String(config.PORT)} (${config.NODE_ENV})`);
