/**
 * The deterministic, idempotent seed (docs/07 §11): the three demo tenants, their plans, domains, org roots, system
 * roles and password-less demo accounts. Uses the APP roles, so it goes through RLS like the real app. Run by
 * `pnpm db:seed` (scripts/seed.ts) and by the migrate image (spec 0019), compiled.
 */
import type { ProductKey } from '@univarse/contracts';
import { createPlatformClient, createTenantShardClient, lagosDay, profileContentHash, projectUnitTypes, seedTenantBase, withTenantTx, type TenantTx } from '@univarse/db';
import { canonicalJson, childPath, legacyColumns, TEMPLATES, templateForType } from '@univarse/domain';
import { TENANTS } from './seed-tenants.js';

/** The development domain; the stack seeds `stack.univarse.localhost` (spec 0019 D6). */
export const DEV_DOMAIN = 'univarse.localhost';

export { TENANTS };

// Demo plans (spec 0003): demo-uni has a broader plan than test-poly, so product gating is visible locally.
const PLANS: Record<(typeof TENANTS)[number]['slug'], Partial<Record<ProductKey, boolean>>> = {
  'demo-uni': { core: true, admissions: true, bursary: true, academics: true, helpdesk: true },
  'test-poly': { core: true, admissions: true },
  'paused-uni': { core: true },
};

const DEMO_USERS = [
  { username: 'ADMIN001', emailLocal: 'ict.admin', displayName: 'Ngozi Adeyemi', role: 'INSTITUTION_ADMIN' },
  { username: 'STAFF001', emailLocal: 'lecturer', displayName: 'Dr. Ibrahim Musa', role: 'LECTURER' },
  { username: '25/SCI/CSC/0001', emailLocal: 'student', displayName: 'Chiamaka Okonkwo', role: 'STUDENT' },
] as const;

/**
 * Spec 0042: a small demo tree, so development and the E2E start with a structure. Each unit is written once (found
 * by its code), as the API writes one: its type, its path, its code's reservation and its CREATED change.
 */
const DEMO_TREES: Record<(typeof TENANTS)[number]['slug'], readonly { code: string; name: string; type: string; parent?: string }[]> = {
  'demo-uni': [
    { code: 'SCI', name: 'Faculty of Science', type: 'faculty' },
    { code: 'CSC', name: 'Department of Computer Science', type: 'department', parent: 'SCI' },
    { code: 'MTH', name: 'Department of Mathematics', type: 'department', parent: 'SCI' },
    { code: 'REG', name: 'Registry', type: 'administrative_department' },
  ],
  'test-poly': [
    { code: 'SICT', name: 'School of Information and Communication Technology', type: 'school' },
    { code: 'CSC', name: 'Department of Computer Science', type: 'department', parent: 'SICT' },
  ],
  'paused-uni': [],
};

async function seedTree(tx: TenantTx, tenantId: string, units: (typeof DEMO_TREES)[keyof typeof DEMO_TREES]): Promise<void> {
  const types = new Map((await tx.unitType.findMany({ select: { id: true, key: true, kind: true } })).map((t) => [t.key, t]));
  for (const u of units) {
    if (await tx.orgUnit.findUnique({ where: { tenantId_code: { tenantId, code: u.code } }, select: { id: true } })) continue;
    const type = types.get(u.type);
    if (!type) throw new Error(`Seed unit type ${u.type} is missing`);
    const parent = await tx.orgUnit.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code: u.parent ?? 'ROOT' } }, select: { id: true, path: true } });
    const row = await tx.orgUnit.create({
      data: { tenantId, code: u.code, name: u.name, typeId: type.id, parentId: parent.id, path: parent.path, ...legacyColumns(type.kind, type.key, 'ACTIVE') },
      select: { id: true },
    });
    await tx.orgUnit.update({ where: { id: row.id }, data: { path: childPath(parent.path, row.id) } });
    await tx.orgUnitCode.create({ data: { tenantId, code: u.code, unitId: row.id } });
    await tx.orgUnitChange.create({ data: { tenantId, unitId: row.id, kind: 'CREATED', code: u.code, name: u.name, typeId: type.id, parentId: parent.id, state: 'ACTIVE', effectiveFrom: lagosDay() } });
  }
}

export interface SeedOptions {
  /** The platform database as the APP role, so the seed goes through RLS like the app. */
  readonly platformUrl: string;
  /** The tenant pool as the APP role. */
  readonly tenantUrl: string;
  /** Tenant subdomains are `<slug>.<domain>`. */
  readonly domain?: string;
  /** Progress lines (no secrets). */
  readonly log?: (line: string) => void;
}

/** Deterministic and idempotent: running it twice changes nothing the first run set up (docs/07 §11). */
export async function seed({ platformUrl, tenantUrl, domain = DEV_DOMAIN, log = () => undefined }: SeedOptions): Promise<void> {
  const platform = createPlatformClient(platformUrl);
  const shardClient = createTenantShardClient(tenantUrl);

  // Spec 0039: the platform migration registers the bootstrap's pool; the app's role only reads shards now.
  const shard = await platform.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } });

  for (const t of TENANTS) {
    const tenant = await platform.tenant.upsert({
      where: { slug: t.slug },
      update: { status: t.status },
      create: { ...t, shardId: shard.id },
    });
    // Entitlements are platform-owned (spec 0003 P9). The seed only creates a missing row: re-seeding used to reset
    // the plan, which would now undo a grant or revocation made in the console at every deploy (spec 0033).
    for (const [product, entitled] of Object.entries(PLANS[t.slug])) {
      await platform.tenantProduct.upsert({
        where: { tenantId_product: { tenantId: tenant.id, product } },
        update: {}, // spec 0033: the seed runs on every deploy, and the console owns this from then on
        create: { tenantId: tenant.id, product, entitled, enabled: entitled && product === 'core' },
      });
    }
    // Spec 0041 Q5: the seed asks for its institutions' profiles; the worker's pass assigns them (the snapshot, its
    // audit and ASSIGNED), as for every institution live without one. An existing row is never touched.
    const template = TEMPLATES[templateForType(t.type)];
    await platform.tenantProfileAssignment.createMany({
      data: [{ tenantId: tenant.id, template: template.id, templateVersion: template.version, contentHash: profileContentHash(canonicalJson(template.profile)), source: 'SEED' }],
      skipDuplicates: true,
    });
    const hostname = `${t.slug}.${domain}`;
    await platform.tenantDomain.upsert({
      where: { hostname },
      update: {},
      create: { tenantId: tenant.id, hostname, kind: 'SUBDOMAIN', verifiedAt: new Date() },
    });

    await withTenantTx(shardClient, tenant.id, async (tx) => {
      // The base a provisioned institution gets too (spec 0034 Q5); then, for the demo tenants only, their accounts.
      const roleIds = await seedTenantBase(tx, tenant.id, t.legalName);
      // Spec 0042 Q-A9: the template's unit types, as the pass would project them from the same profile (it then finds
      // them there and changes nothing), so the demo tree can be written in this same run.
      await projectUnitTypes(tx, tenant.id, template.profile.unitTypes);
      await seedTree(tx, tenant.id, DEMO_TREES[t.slug]);

      // Demo accounts: NO passwords. Activate via /api/v1/auth/activation/* (code arrives in Mailpit).
      for (const u of DEMO_USERS) {
        const user = await tx.userAccount.upsert({
          where: { tenantId_username: { tenantId: tenant.id, username: u.username } },
          update: {},
          create: {
            tenantId: tenant.id,
            username: u.username,
            email: `${u.emailLocal}@${t.slug}.test`,
            displayName: u.displayName,
          },
        });
        const roleId = roleIds.get(u.role);
        if (!roleId) throw new Error(`Seed role ${u.role} was not created`);
        const exists = await tx.roleAssignment.findFirst({ where: { userId: user.id, roleId, revokedAt: null } });
        if (!exists) {
          await tx.roleAssignment.create({
            data: { tenantId: tenant.id, userId: user.id, roleId, scopeType: 'INSTITUTION', reason: 'seed' },
          });
        }
      }
    });
    log(`  ✓ ${t.slug} (${t.status}) → ${hostname}`);
  }

  await Promise.all([platform.$disconnect(), shardClient.$disconnect()]);
}
