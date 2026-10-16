// Spec 0017: `pnpm test:int:pgbouncer` — locally, what the pgbouncer-isolation CI job runs:
//   1. PgBouncer in the probe profile: PB7 through the API, then PB1, PB2, PB5, PB6, PB9;
//   2. PgBouncer in the suite profile: the DB isolation, crypto and API integration suites, every app URL through it;
//   3. PgBouncer stopped, whatever happened.
// It builds the workspace first (the API runs @univarse/db's and @univarse/crypto's built output, and a stale build
// gave misleading failures), and checks the superuser is configured before starting anything.
// It needs `pnpm db:setup` and `pnpm db:migrate` done, and the superuser for PB5, PB7's control and PB2's cleanup
// (PGHOST, PGPORT, PGSUPERPASSWORD).
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

/**
 * pnpm itself, never through a shell (a shell joins arguments unescaped: Node's DEP0190). Run as a pnpm script,
 * `npm_execpath` is pnpm's own JavaScript entry, which Node runs directly on every platform; on Windows pnpm is
 * otherwise a .cmd, which only a shell can start, so this refuses rather than fall back to one.
 */
export function pnpmCommand(env = process.env, platform = process.platform) {
  const entry = env.npm_execpath;
  if (entry && /pnpm/i.test(entry) && /\.c?js$/i.test(entry)) return [process.execPath, [entry]];
  if (platform === 'win32')
    throw new Error(
      'run this through pnpm (pnpm test:int:pgbouncer), so pnpm can be called without a shell',
    );
  return ['pnpm', []];
}

const pnpm = (args, env = {}) => {
  const [cmd, pre] = pnpmCommand();
  return (
    spawnSync(cmd, [...pre, ...args], { stdio: 'inherit', env: { ...process.env, ...env } })
      .status === 0
  );
};

async function main() {
  if (!process.env.PGSUPERPASSWORD)
    throw new Error(
      'PGSUPERPASSWORD is not set: the probes need the superuser (PowerShell: $env:PGSUPERPASSWORD = Read-Host -MaskInput)',
    );
  if (!pnpm(['build'])) throw new Error('pnpm build failed: the suites would run stale code');
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
