// Spec 0016 IO17: the relay role's URL for the relay's integration tests, from .env.worker only (never
// process.env, where the API's config would refuse it). UNIVARSE_RELAY_THROUGH_PGBOUNCER=1 picks the PgBouncer URL,
// as the pgbouncer-isolation suites do. Same rule as packages/db/scripts/env.ts relayUrl().
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const WORKER_ENV = new URL('../../../../.env.worker', import.meta.url);

export function relayUrl(): string {
  const key =
    process.env.UNIVARSE_RELAY_THROUGH_PGBOUNCER === '1'
      ? 'PGBOUNCER_PLATFORM_RELAY_URL'
      : 'PLATFORM_RELAY_URL';
  const v = existsSync(WORKER_ENV) ? parseEnv(readFileSync(WORKER_ENV, 'utf8'))[key] : undefined;
  if (!v) throw new Error(`Missing ${key} in .env.worker. Run \`pnpm db:setup\` first.`);
  return v;
}
