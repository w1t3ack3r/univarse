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
    const retired = { email: { endsWith: '@staff.test' }, isActive: false, role: 'READ_ONLY' as const };
    // Spec 0037: a request names its requester and decider with a restricting key (members are never deleted for real),
    // so a test member's approvals go first.
    const gone = (await db.platformUser.findMany({ where: retired, select: { id: true } })).map((m) => m.id);
    await db.platformApproval.deleteMany({ where: { OR: [{ requestedBy: { in: gone } }, { decidedBy: { in: gone } }] } });
    // So does a suspension (spec 0037 Q6): test members only ever suspend test institutions.
    await db.platformTenantSuspension.deleteMany({ where: { OR: [{ suspendedBy: { in: gone } }, { resumedBy: { in: gone } }] } });
    // And a notice (spec 0037 Q9): test members only ever write to test institutions, by hand or by a pilot ring.
    const notices = { OR: [{ createdBy: { in: gone } }, { publishedBy: { in: gone } }, { withdrawnBy: { in: gone } }] };
    await db.platformNoticeDelivery.deleteMany({ where: { notice: notices } });
    await db.platformNotice.deleteMany({ where: notices });
    // And an incident (spec 0037 Q13): its timeline goes with it, here only (it's append-only for every other purpose).
    const incidents = (await db.platformIncident.findMany({ where: { OR: [{ openedBy: { in: gone } }, { updates: { some: { postedBy: { in: gone } } } }] }, select: { id: true } })).map((i) => i.id);
    if (incidents.length) {
      await db.$executeRaw`ALTER TABLE platform_incident_update DISABLE TRIGGER platform_incident_update_append_only`;
      try {
        await db.platformIncidentUpdate.deleteMany({ where: { incidentId: { in: incidents } } });
      } finally {
        await db.$executeRaw`ALTER TABLE platform_incident_update ENABLE TRIGGER platform_incident_update_append_only`;
      }
      await db.platformIncidentTenant.deleteMany({ where: { incidentId: { in: incidents } } });
      await db.platformIncident.deleteMany({ where: { id: { in: incidents } } });
    }
    const pruned = await db.platformUser.deleteMany({ where: { id: { in: gone } } });
    // A month a test attested stays open for the owner: a review doesn't outlive its reviewer here (no foreign key, as
    // the audit log's actors).
    const staff = await db.platformUser.findMany({ select: { id: true } });
    await db.platformAccessReview.deleteMany({ where: { reviewerId: { notIn: staff.map((m) => m.id) } } });
    return pruned.count;
  } finally {
    await db.$disconnect();
  }
}
