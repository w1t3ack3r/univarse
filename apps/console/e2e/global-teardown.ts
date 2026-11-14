// The development database is shared: an OWNER this run left active would make `pnpm console:owner` refuse. Every
// member the journeys made (and only those) loses its role, its access and its sessions, as the console role; then the
// migrator (from the root .env, which the console never reads) removes retired test members, so the Staff page lists
// real people only.
import { createPlatformClient } from '@univarse/db';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pruneRetiredTestStaff } from '../../api/src/testing/staff-cleanup.js';
import { pruneTestTenants } from '../../api/src/testing/tenant-cleanup.js';
import { consoleEnv, E2E_PREFIX, E2E_PROVISIONED_PREFIX, E2E_TENANT_PREFIX } from './fixtures';

const rootEnv = new URL('../../../.env', import.meta.url);

export default async function globalTeardown(): Promise<void> {
  const db = createPlatformClient(consoleEnv().CONSOLE_DATABASE_URL!);
  try {
    const email = { startsWith: E2E_PREFIX, endsWith: '@staff.test' };
    await db.platformSession.updateMany({ where: { user: { email }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
    await db.platformUser.updateMany({ where: { email }, data: { role: 'READ_ONLY', isActive: false } });
  } finally {
    await db.$disconnect();
  }
  if (!existsSync(rootEnv)) return;
  const env = parseEnv(readFileSync(rootEnv, 'utf8'));
  const migrator = env.PLATFORM_MIGRATOR_URL;
  await pruneRetiredTestStaff(migrator);
  // Spec 0034: provisioned institutions have rows on both sides, and a key and a job that block a plain delete.
  await pruneTestTenants({ platformMigratorUrl: migrator, tenantMigratorUrl: env.TENANT_POOL_01_MIGRATOR_URL }, E2E_PROVISIONED_PREFIX);
  if (!migrator) return;
  const owner = createPlatformClient(migrator);
  try {
    await owner.platformTenantSuspension.deleteMany({ where: { tenant: { slug: { startsWith: E2E_TENANT_PREFIX } } } });
    await owner.tenant.deleteMany({ where: { slug: { startsWith: E2E_TENANT_PREFIX } } });
  } finally {
    await owner.$disconnect();
  }
}
