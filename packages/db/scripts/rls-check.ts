/**
 * Static tenant-isolation checker — a CI gate (docs/07 §3.3, docs/12 §3). The check itself is @univarse/db-ops (rls-check.ts)
 * (the migrate image runs it compiled, spec 0019); this is its command line.
 *
 *   pnpm rls:check
 */
import { rlsCheck } from '../../db-ops/src/rls-check.js';
import { loadRootEnv, requireEnv } from './env.js';

async function main() {
  loadRootEnv();
  const { problems, tables } = await rlsCheck({
    tenantMigratorUrl: requireEnv('TENANT_POOL_01_MIGRATOR_URL'),
    platformMigratorUrl: requireEnv('PLATFORM_MIGRATOR_URL'),
  });
  if (problems.length > 0) {
    console.error(`✗ RLS check failed (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ RLS check passed: ${tables} tenant tables isolated, all uniques and FKs tenant-scoped.`);
  console.log('✓ Platform invalidation capture intact: 9 triggers ENABLE ALWAYS, functions locked down, no TEMPORARY, the maximum TTL unchanged.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
