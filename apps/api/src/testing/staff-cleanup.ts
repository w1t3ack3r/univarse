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
    // Spec 0031: what the tests date in the far future, because the console role can't delete: nothing real is there.
    await db.platformAccessReview.deleteMany({ where: { period: { gte: '2100' } } });
    await db.platformSecurityEventRollup.deleteMany({ where: { minute: { gte: new Date('2100-01-01T00:00:00Z') } } });
    const pruned = await db.platformUser.deleteMany({ where: { email: { endsWith: '@staff.test' }, isActive: false, role: 'READ_ONLY' } });
    // A month a test attested stays open for the owner: a review doesn't outlive its reviewer here (no foreign key, as
    // the audit log's actors).
    const staff = await db.platformUser.findMany({ select: { id: true } });
    await db.platformAccessReview.deleteMany({ where: { reviewerId: { notIn: staff.map((m) => m.id) } } });
    return pruned.count;
  } finally {
    await db.$disconnect();
  }
}
