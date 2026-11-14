// Development's database is shared by the tests and the owner's own work. A test that provisions an institution leaves
// rows on both sides: the platform's (its job, key, host and products) and its tenant database's (its roles, settings,
// accounts, audit and outbox). This removes exactly the institutions it's given, as the two migrators: the tenant side
// one institution at a time under its own RLS context (the migrator doesn't bypass RLS), then the platform side. The
// platform audit chain keeps its rows: it's append-only, and holds a tenant id with no foreign key.
import { createPlatformClient, createTenantShardClient, withTenantTx } from '@univarse/db';

/** Children before parents, as the tenant database's foreign keys need. */
const TENANT_TABLES = [
  'contact_change',
  'notice_dismissal',
  'mfa_challenge',
  'mfa_factor',
  'one_time_token',
  'recovery_code',
  'session',
  'role_assignment',
  'file_object',
  'outbox_event',
  'setting',
  'audit_event',
  'sequence',
  'user_account',
  'role',
  'org_unit',
] as const;

export interface CleanupUrls {
  readonly platformMigratorUrl: string | undefined;
  readonly tenantMigratorUrl: string | undefined;
}

/**
 * Removes the test institutions whose slug starts with `prefix`. A prefix is required and must look like a test's
 * (`e2e-`, `prov-`, `susp-`): nothing else is ever pruned. Returns how many were removed.
 */
export async function pruneTestTenants(urls: CleanupUrls, prefix: string): Promise<number> {
  if (!/^(e2e|prov|susp|ntc|inc)-[a-z0-9-]*$/.test(prefix)) throw new Error(`refusing to prune tenants by the prefix "${prefix}"`);
  if (!urls.platformMigratorUrl || !urls.tenantMigratorUrl) return 0;
  const platform = createPlatformClient(urls.platformMigratorUrl);
  const shard = createTenantShardClient(urls.tenantMigratorUrl);
  try {
    const tenants = await platform.tenant.findMany({ where: { slug: { startsWith: prefix } }, select: { id: true } });
    if (tenants.length === 0) return 0;
    for (const t of tenants) {
      await withTenantTx(shard, t.id, async (tx) => {
        for (const table of TENANT_TABLES) await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, t.id);
      });
    }
    const ids = tenants.map((t) => t.id);
    await platform.$transaction(async (tx) => {
      await tx.provisioningJob.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.platformTenantSuspension.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.platformNoticeDelivery.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.platformIncidentTenant.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.keyDestruction.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.keyReencryption.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenantDataKey.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
    return ids.length;
  } finally {
    await Promise.all([platform.$disconnect(), shard.$disconnect()]);
  }
}
