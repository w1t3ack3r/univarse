// The platform API's settings for its integration tests: .env.console only (from `pnpm db:setup`), like platform.ts,
// never the root .env. The relay is off: tests drain the outbox themselves.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadPlatformConfig, type PlatformConfig } from '../platform/platform-config.js';

const file = new URL('../../../../.env.console', import.meta.url);

export function consoleEnv(): Record<string, string> {
  const env = existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {};
  if (!env.CONSOLE_DATABASE_URL || !env.CONSOLE_CODE_PEPPER) throw new Error('.env.console lacks the platform API\'s settings: run `pnpm db:setup`');
  return env;
}

export function platformTestConfig(over: Record<string, string> = {}): PlatformConfig {
  return loadPlatformConfig({ ...consoleEnv(), NODE_ENV: 'test', MAIL_RELAY_INTERVAL_MS: '0', ...over });
}
