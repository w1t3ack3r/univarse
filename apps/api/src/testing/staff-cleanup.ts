// Development's database is shared by the tests and the owner's own console. The console role has no DELETE (spec 0028
// Q-A2), so tests can only retire the members they make; this removes them afterwards, as the migrator (the tables'
// owner), so the Staff page lists real people only. Test members only: an address on @staff.test that is already
// retired (no access, READ_ONLY). Their sessions, factors, codes and devices go with them (ON DELETE CASCADE); the
// platform audit log keeps its rows, which hold an actor id with no foreign key.
import { createPlatformClient } from '@univarse/db';

export async function pruneRetiredTestStaff(migratorUrl: string | undefined): Promise<number> {
  if (!migratorUrl) return 0;
  const db = createPlatformClient(migratorUrl);
  try {
    return (await db.platformUser.deleteMany({ where: { email: { endsWith: '@staff.test' }, isActive: false, role: 'READ_ONLY' } })).count;
  } finally {
    await db.$disconnect();
  }
}
