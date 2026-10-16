// Spec 0017: `pnpm test:int:pgbouncer` — locally, what the pgbouncer-isolation CI job runs:
//   1. PgBouncer in the probe profile: PB7 through the API, then PB1, PB2, PB5, PB6, PB9;
//   2. PgBouncer in the suite profile: the DB isolation, crypto and API integration suites, every app URL through it;
//   3. PgBouncer stopped, whatever happened.
// It needs `pnpm db:setup` and `pnpm db:migrate` done, and the superuser for PB5 (PGHOST, PGPORT, PGSUPERPASSWORD).
// The PB9 rotation re-runs db:setup, so it rotates your local passwords: it runs only with PGBOUNCER_PROBE_ROTATION=1.
// Serialise it with other integration runs, as usual.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { start, stop } from './run.mjs';

/** The values of .env (db:setup writes the PgBouncer URLs there). */
export function readEnvFile(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const pnpm = (args, env = {}) =>
  spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  }).status === 0;

async function main() {
  const failed = [];
  try {
    await start({ profile: 'probe' });
    const env = readEnvFile(readFileSync('.env', 'utf8'));
    const through = {
      PLATFORM_DATABASE_URL: env.PGBOUNCER_PLATFORM_DATABASE_URL,
      TENANT_POOL_01_DATABASE_URL: env.PGBOUNCER_TENANT_POOL_01_DATABASE_URL,
    };
    if (!through.PLATFORM_DATABASE_URL || !through.TENANT_POOL_01_DATABASE_URL)
      throw new Error('.env has no PgBouncer URLs: run pnpm db:setup first');
    if (!pnpm(['--filter', '@univarse/api', 'test:pgbouncer:probe'], through))
      failed.push('PB7 (API probe)');
    if (!pnpm(['--filter', '@univarse/db', 'test:pgbouncer:probe']))
      failed.push('the pooling probes');
    await start({ profile: 'suite' });
    const after = readEnvFile(readFileSync('.env', 'utf8')); // a rotation may have changed them
    const suiteEnv = {
      PLATFORM_DATABASE_URL: after.PGBOUNCER_PLATFORM_DATABASE_URL,
      TENANT_POOL_01_DATABASE_URL: after.PGBOUNCER_TENANT_POOL_01_DATABASE_URL,
    };
    for (const pkg of ['@univarse/db', '@univarse/crypto', '@univarse/api'])
      if (!pnpm(['--filter', pkg, 'test:int'], suiteEnv)) failed.push(`${pkg} test:int`);
  } finally {
    stop();
  }
  if (failed.length) {
    console.error(`[test:int:pgbouncer] FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('[test:int:pgbouncer] PASS: the probes and the three suites, through PgBouncer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(`[test:int:pgbouncer] ${e.message}`);
    process.exit(1);
  });
