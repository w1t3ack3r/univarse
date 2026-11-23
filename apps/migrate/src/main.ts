// Spec 0019 D3: the migrate image's entrypoint (`node dist/main.js`). The job is job.ts; this wires its real steps.
// Configuration comes only from the environment (the stack's env file); nothing is read from disk but the Prisma
// configs and migrations shipped in the image.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient } from '@univarse/db';
import { bootstrap, rlsCheck, seed } from '@univarse/db-ops';
import { runJob, type JobEnv } from './job.js';
import { appliedMigrations, commitFrom, databaseOf, prismaTenant, realShardSteps, recordPlatformRun } from './real-shards.js';
import { migrateShards, newlyApplied, type RunOutcome } from './shards.js';

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const config = (which: 'platform' | 'tenant') => fileURLToPath(new URL(`../prisma/${which}.config.mjs`, import.meta.url));
const need = (env: JobEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

/** A superuser connection to `database`, from the superuser URL with its database replaced. */
async function superuser(url: string, database: string): Promise<pg.Client> {
  const u = new URL(url);
  u.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

/** `prisma migrate <command>` for the platform database, its output shown (it names hosts and databases, never passwords). */
function prismaPlatform(command: 'deploy' | 'status'): Promise<void> {
  const r = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', command, '--config', config('platform')], {
    stdio: 'inherit',
    env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  if (r.status !== 0) return Promise.reject(new Error(`prisma migrate ${command} (platform) exited ${String(r.status ?? r.signal)}`));
  return Promise.resolve();
}

// Spec 0039 Q8: one id for every run this job records; the release's commit from the image's version.
const JOB_ID = randomUUID();
const TENANT = { prismaCli: PRISMA_CLI, tenantConfig: config('tenant') };
const shardSteps = (env: JobEnv, log: (l: string) => void) =>
  realShardSteps({ env, platformMigratorUrl: need(env, 'PLATFORM_MIGRATOR_URL'), jobId: JOB_ID, ...TENANT, rlsCheck, log });

await runJob(process.env, {
  bootstrap: (env) =>
    bootstrap({
      connect: (db) => superuser(need(env, 'BOOTSTRAP_SUPERUSER_URL'), db),
      passwords: {
        migrator: need(env, 'ROLE_VERIFIER_MIGRATOR'),
        app: need(env, 'ROLE_VERIFIER_APP'),
        appPlatform: need(env, 'ROLE_VERIFIER_APP_PLATFORM'),
        relayPlatform: need(env, 'ROLE_VERIFIER_RELAY_PLATFORM'),
      },
      migratorCreatedb: false, // production shape: no shadow databases
      backupPassword: env.ROLE_VERIFIER_BACKUP, // spec 0020 B-3: the stack's base backups
      consolePassword: env.ROLE_VERIFIER_CONSOLE, // spec 0027 P5: the platform API's role
      log: (l) => console.log(l),
    }),
  // Q8: the platform's run, recorded after its migrations (they create the table on the first deploy).
  migratePlatform: async (env) => {
    const url = need(env, 'PLATFORM_MIGRATOR_URL');
    const startedAt = new Date();
    const before = await appliedMigrations(url);
    if (before === 'unreachable') throw new Error('the platform database is unreachable as the migrator');
    let failure: unknown = null;
    try {
      await prismaPlatform('deploy');
    } catch (e) {
      failure = e;
    }
    const after = await appliedMigrations(url);
    const done = after === 'unreachable' ? [] : newlyApplied(before, after);
    const outcome: RunOutcome = failure
      ? { status: 'FAILED', code: 'migrate_failed', applied: done.length, lastMigration: done.at(-1) ?? null }
      : { status: 'SUCCEEDED', applied: done.length, lastMigration: done.at(-1) ?? null };
    try {
      await recordPlatformRun(url, { jobId: JOB_ID, commit: commitFrom(env.UNIVARSE_VERSION), database: databaseOf(url), startedAt, outcome });
    } catch (e) {
      // Before this release's migration the table doesn't exist: a failed platform run can't always be recorded.
      if (!failure) throw e;
    }
    if (failure) throw failure instanceof Error ? failure : new Error('the platform migration failed');
    console.log(`[migrate] platform: ${String(done.length)} migration(s) applied`);
  },
  migrateShards: async (env) => {
    const steps = await shardSteps(env, (l) => console.log(l));
    try {
      return await migrateShards(steps);
    } finally {
      await steps.close();
    }
  },
  status: () => prismaPlatform('status'),
  // B-14: every shard up to date and isolated; changes nothing (no run is recorded, no status set).
  checkShards: async (env) => {
    const steps = await shardSteps(env, (l) => console.log(l));
    const problems: string[] = [];
    try {
      for (const shard of await steps.listShards()) {
        const url = steps.migratorUrl(shard);
        if (!url) {
          problems.push(`${shard.name}: no migrator URL in the environment`);
          continue;
        }
        await prismaTenant(TENANT, 'status', url).catch(() => problems.push(`${shard.name}: migrations not up to date`));
        for (const p of await steps.rlsCheck(url)) problems.push(`${shard.name}: ${p}`);
      }
    } finally {
      await steps.close();
    }
    return problems;
  },
  seed: (env) =>
    seed({
      platformUrl: need(env, 'PLATFORM_DATABASE_URL'),
      tenantUrl: need(env, 'TENANT_POOL_01_DATABASE_URL'),
      domain: need(env, 'SEED_DOMAIN'),
      log: (l) => console.log(l),
    }),
  provisionKeys: async (env) => {
    const platform = createPlatformClient(need(env, 'PLATFORM_DATABASE_URL'));
    const provider = keyProviderFrom({
      KEY_PROVIDER: env.KEY_PROVIDER === 'local' ? 'local' : 'vault',
      NODE_ENV: env.NODE_ENV,
      VAULT_ADDR: env.VAULT_ADDR,
      VAULT_TOKEN: env.VAULT_TOKEN,
      VAULT_TRANSIT_MOUNT: env.VAULT_TRANSIT_MOUNT,
      VAULT_TRANSIT_KEY: env.VAULT_TRANSIT_KEY,
      LOCAL_KEK: env.LOCAL_KEK,
    });
    try {
      for (const t of await platform.tenant.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } })) {
        const { version, created } = await provisionTenantKey(platform, provider, t.id);
        console.log(`  ${created ? '✓ created' : '· kept   '} data key v${String(version)} for ${t.slug} (${provider.kekId})`);
      }
    } finally {
      await platform.$disconnect();
    }
  },
  log: (l) => console.log(l),
}, { checkOnly: process.argv.includes('--check-only') }).then(
  ({ failedShards }) => {
    // Q9: the platform and every other shard migrated; these are in maintenance. The deploy goes on and says so.
    if (failedShards.length) {
      console.error(`[migrate] SHARDS IN MAINTENANCE: ${failedShards.map((f) => `${f.name} (${f.code})`).join(', ')}`);
      process.exit(3);
    }
  },
  (err: unknown) => {
    console.error(`[migrate] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
