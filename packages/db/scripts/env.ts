import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ROOT_ENV_PATH = resolve(REPO_ROOT, '.env');
/** The worker-only env file (spec 0016 IO17): the relay's credentials. Git-ignored (.env.*). */
export const WORKER_ENV_PATH = resolve(REPO_ROOT, '.env.worker');
/** The platform API's env file (spec 0027 P5): the console role's URL, read by `platform.ts` only. Git-ignored (.env.*). */
export const CONSOLE_ENV_PATH = resolve(REPO_ROOT, '.env.console');

/** Loads the repo-root .env (git-ignored) if present. Real env vars win. */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV_PATH)) process.loadEnvFile(ROOT_ENV_PATH);
}

/**
 * The relay role's URL for tests (spec 0016 IO17): read from .env.worker, never from process.env, so a test
 * process never holds it where the API's config would see it. With UNIVARSE_RELAY_THROUGH_PGBOUNCER=1 (the
 * pgbouncer-isolation suites) it is the PgBouncer URL.
 */
export function relayUrl(): string {
  const key = process.env.UNIVARSE_RELAY_THROUGH_PGBOUNCER === '1' ? 'PGBOUNCER_PLATFORM_RELAY_URL' : 'PLATFORM_RELAY_URL';
  const v = existsSync(WORKER_ENV_PATH) ? parseEnv(readFileSync(WORKER_ENV_PATH, 'utf8'))[key] : undefined;
  if (!v) throw new Error(`Missing ${key} in .env.worker. Run \`pnpm db:setup\` first.`);
  return v;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Run \`pnpm db:setup\` first.`);
  return v;
}
