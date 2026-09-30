/**
 * Deterministic, idempotent development seed (docs/07 §11).
 *   pnpm db:seed
 * Uses the APP roles (not the migrator), so it goes through RLS like the real app.
 */
import { createPlatformClient } from '../src/platform.js';
import { createTenantShardClient, withTenantTx } from '../src/tenant.js';
import { loadRootEnv, requireEnv } from './env.js';

const DEV_DOMAIN = 'univarse.localhost';

const TENANTS = [
  { slug: 'demo-uni', legalName: 'Demo University, Lagos', shortName: 'DEMO-UNI', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE' },
  { slug: 'test-poly', legalName: 'Test State Polytechnic', shortName: 'TESTPOLY', type: 'POLYTECHNIC', ownership: 'STATE', status: 'ACTIVE' },
  { slug: 'paused-uni', legalName: 'Paused University', shortName: 'PAUSED', type: 'UNIVERSITY', ownership: 'FEDERAL', status: 'SUSPENDED' },
] as const;

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

async function main() {
  loadRootEnv();
  const platform = createPlatformClient(requireEnv('PLATFORM_DATABASE_URL'));
  const shardClient = createTenantShardClient(requireEnv('TENANT_POOL_01_DATABASE_URL'));

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
    const hostname = `${t.slug}.${DEV_DOMAIN}`;
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
      for (const [key, name] of SYSTEM_ROLES) {
        await tx.role.upsert({
          where: { tenantId_key: { tenantId: tenant.id, key } },
          update: { name },
          create: { tenantId: tenant.id, key, name, isSystem: true, permissions: [] },
        });
      }
    });
    console.log(`  ✓ ${t.slug} (${t.status}) → http://${hostname}`);
  }

  await Promise.all([platform.$disconnect(), shardClient.$disconnect()]);
  console.log('Seed complete.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
