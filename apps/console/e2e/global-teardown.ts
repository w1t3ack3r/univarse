// The development database is shared: an OWNER this run left active would make `pnpm console:owner` refuse. Every
// member the journeys made (and only those) loses its role, its access and its sessions.
import { createPlatformClient } from '@univarse/db';
import { consoleEnv, E2E_PREFIX } from './fixtures';

export default async function globalTeardown(): Promise<void> {
  const db = createPlatformClient(consoleEnv().CONSOLE_DATABASE_URL!);
  try {
    const email = { startsWith: E2E_PREFIX, endsWith: '@staff.test' };
    await db.platformSession.updateMany({ where: { user: { email }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
    await db.platformUser.updateMany({ where: { email }, data: { role: 'READ_ONLY', isActive: false } });
  } finally {
    await db.$disconnect();
  }
}
