/**
 * The deterministic, idempotent seed (docs/07 §11): the three demo tenants, their plans, domains, org roots, system
 * roles and password-less demo accounts. Uses the APP roles, so it goes through RLS like the real app. Run by
 * `pnpm db:seed` (scripts/seed.ts) and by the migrate image (spec 0019), compiled.
 */
import { EVERY_ROLE_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type ProductKey } from '@univarse/contracts';
import { createPlatformClient, createTenantShardClient, withTenantTx } from '@univarse/db';
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

// System roles seeded per tenant (docs/03 §2). Permissions are attached as modules land.
const SYSTEM_ROLES: [string, string][] = [
  ['INSTITUTION_ADMIN', 'Institution Administrator'],
  ['REGISTRAR', 'Registrar'],
  ['EXAMS_RECORDS_OFFICER', 'Exams & Records Officer'],
  ['ADMISSIONS_OFFICER', 'Admissions Officer'],
  ['BURSAR', 'Bursar'],
  ['BURSARY_OFFICER', 'Bursary Officer'],
  ['DEAN', 'Dean'],
  ['HOD', 'Head of Department'],
  ['LEVEL_ADVISER', 'Level Adviser'],
  ['LECTURER', 'Lecturer'],
  ['STUDENT_AFFAIRS_OFFICER', 'Student Affairs Officer'],
  ['HOSTEL_OFFICER', 'Hostel Officer'],
  ['LIBRARIAN', 'Librarian'],
  ['CLEARANCE_OFFICER', 'Clearance Officer'],
  ['MANAGEMENT_VIEWER', 'Management (read-only)'],
  ['HELPDESK_AGENT', 'Helpdesk Agent'],
  ['STUDENT', 'Student'],
  ['APPLICANT', 'Applicant'],
];

const DEMO_USERS = [
  { username: 'ADMIN001', emailLocal: 'ict.admin', displayName: 'Ngozi Adeyemi', role: 'INSTITUTION_ADMIN' },
  { username: 'STAFF001', emailLocal: 'lecturer', displayName: 'Dr. Ibrahim Musa', role: 'LECTURER' },
  { username: '25/SCI/CSC/0001', emailLocal: 'student', displayName: 'Chiamaka Okonkwo', role: 'STUDENT' },
] as const;

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

  const shard = await platform.shard.upsert({
    where: { name: 'pool-01' },
    update: {},
    create: { name: 'pool-01', kind: 'POOL', secretRef: 'TENANT_POOL_01_DATABASE_URL', region: 'local' },
  });

  for (const t of TENANTS) {
    const tenant = await platform.tenant.upsert({
      where: { slug: t.slug },
      update: { status: t.status },
      create: { ...t, shardId: shard.id },
    });
    // Entitlements are platform-owned (spec 0003 P9): re-seeding resets the plan, never the institution's switches.
    for (const [product, entitled] of Object.entries(PLANS[t.slug])) {
      await platform.tenantProduct.upsert({
        where: { tenantId_product: { tenantId: tenant.id, product } },
        update: { entitled, ...(entitled ? {} : { enabled: false }) },
        create: { tenantId: tenant.id, product, entitled, enabled: entitled && product === 'core' },
      });
    }
    const hostname = `${t.slug}.${domain}`;
    await platform.tenantDomain.upsert({
      where: { hostname },
      update: {},
      create: { tenantId: tenant.id, hostname, kind: 'SUBDOMAIN', verifiedAt: new Date() },
    });

    await withTenantTx(shardClient, tenant.id, async (tx) => {
      const root = await tx.orgUnit.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: 'ROOT' } },
        update: {},
        create: { tenantId: tenant.id, code: 'ROOT', name: t.legalName, kind: 'ACADEMIC', type: 'INSTITUTION', path: '/' },
      });
      if (root.path === '/') {
        await tx.orgUnit.update({ where: { id: root.id }, data: { path: `/${root.id}/` } });
      }
      const roleIds = new Map<string, string>();
      for (const [key, name] of SYSTEM_ROLES) {
        const permissions = [...new Set([...(SYSTEM_ROLE_PERMISSIONS[key] ?? []), ...EVERY_ROLE_PERMISSIONS])];
        const role = await tx.role.upsert({
          where: { tenantId_key: { tenantId: tenant.id, key } },
          update: { name, permissions },
          create: { tenantId: tenant.id, key, name, isSystem: true, permissions },
        });
        roleIds.set(key, role.id);
      }

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
