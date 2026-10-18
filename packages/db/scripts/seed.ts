/**
 * Deterministic, idempotent development seed (docs/07 §11). The seed itself is @univarse/db-ops (seed.ts); this is its
 * command line, on the development domain.
 *   pnpm db:seed
 */
import { seed } from '../../db-ops/src/seed.js';
import { loadRootEnv, requireEnv } from './env.js';

loadRootEnv();
seed({
  platformUrl: requireEnv('PLATFORM_DATABASE_URL'),
  tenantUrl: requireEnv('TENANT_POOL_01_DATABASE_URL'),
  log: (line) => console.log(line.replace(/→ (\S+)$/, '→ http://$1')),
})
  .then(() => console.log('Seed complete.'))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
