// Spec 0019 D3: the migrate image's entrypoint (`node dist/main.js`). The job is job.ts; this wires its real steps.
// Configuration comes only from the environment (the stack's env file); nothing is read from disk but the Prisma
// configs and migrations shipped in the image.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient } from '@univarse/db';
import { bootstrap, rlsCheck, seed } from '@univarse/db-ops';
import { runJob, type JobEnv } from './job.js';

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
      log: (l) => console.log(l),
    }),
  migrate: (which) => {
    // Prisma's own output names the datasource's host and database, never its password.
    const r = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--config', config(which)], {
      stdio: 'inherit',
      env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    if (r.status !== 0) return Promise.reject(new Error(`prisma migrate deploy (${which}) exited ${String(r.status ?? r.signal)}`));
    return Promise.resolve();
  },
  rlsCheck: (env) => rlsCheck({ tenantMigratorUrl: need(env, 'TENANT_POOL_01_MIGRATOR_URL'), platformMigratorUrl: need(env, 'PLATFORM_MIGRATOR_URL') }),
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
}).catch((err: unknown) => {
  console.error(`[migrate] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
