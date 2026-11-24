/**
 * Deterministic, idempotent development seed (docs/07 §11). The seed itself is @univarse/db-ops (seed.ts); this is its
 * command line, on the development domain.
 *   pnpm db:seed
 */
import pg from 'pg';
import { seed } from '../../db-ops/src/seed.js';
import { loadRootEnv, requireEnv } from './env.js';

/**
 * Spec 0039 Q7: development's and CI's pool takes this many institutions. Their database keeps hundreds of the tests'
 * own (the stack's pool keeps the approved 50, `[VERIFY]`), and the placement trigger refuses a full pool. Development
 * only: the stack's migrate job runs the seed from db-ops, never this script.
 */
export const DEVELOPMENT_POOL_CAPACITY = 10_000;

async function developmentCapacity(migratorUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: migratorUrl });
  await c.connect();
  try {
    await c.query(`UPDATE shard SET capacity = $1 WHERE name = 'pool-01' AND capacity < $1`, [DEVELOPMENT_POOL_CAPACITY]);
  } finally {
    await c.end();
  }
}

loadRootEnv();
// First: the seed's upserts are inserts to the placement trigger (PostgreSQL runs BEFORE INSERT before ON CONFLICT).
developmentCapacity(requireEnv('PLATFORM_MIGRATOR_URL'))
  .then(() =>
    seed({
      platformUrl: requireEnv('PLATFORM_DATABASE_URL'),
      tenantUrl: requireEnv('TENANT_POOL_01_DATABASE_URL'),
      log: (line) => console.log(line.replace(/→ (\S+)$/, '→ http://$1')),
    }),
  )
  .then(() => console.log(`Seed complete (pool-01 takes ${String(DEVELOPMENT_POOL_CAPACITY)} institutions in development).`))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
