// The development database is shared: an OWNER this run left active would make `pnpm console:owner` refuse. Every
// member the journeys made (and only those) loses its role, its access and its sessions, as the console role; then the
// migrator (from the root .env, which the console never reads) removes retired test members, so the Staff page lists
// real people only.
import { createPlatformClient } from '@univarse/db';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pruneRetiredTestStaff } from '../../api/src/testing/staff-cleanup.js';
import { consoleEnv, E2E_PREFIX } from './fixtures';

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
  if (existsSync(rootEnv)) await pruneRetiredTestStaff(parseEnv(readFileSync(rootEnv, 'utf8')).PLATFORM_MIGRATOR_URL);
}
