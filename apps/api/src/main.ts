import { existsSync } from 'node:fs';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';

// Local dev convenience: repo-root .env. In deployed environments, env comes from the secret manager.
const rootEnv = new URL('../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.PORT, config.HOST);
console.log(`UniVarse API listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
