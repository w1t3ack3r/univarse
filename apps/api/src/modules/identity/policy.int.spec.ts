/**
 * Spec 0018 end to end (real database, the real API): a grant at any resource scope gives nothing institution-wide
 * (PS4), settings' `canManage` and `/auth/me` follow the same rule (PS1), and the database refuses a malformed
 * assignment (PS5). Prereqs: `pnpm dev:infra`, `pnpm db:migrate && pnpm db:seed`.
 *
 * Each user also holds a privileged permission (`settings.tenant.manage`, at the scope under test), so it must
 * enrol MFA first: holding a privileged permission at any scope requires MFA (docs/08 §3.2), while using it is
 * still decided by scope.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createTenantShardClient, forTenant, withTenantTx } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode } from './totp.js';
import { createHarness, HOSTS, PASSWORD, type Harness } from '../../testing/int-harness.js';
import { resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';

const RESOURCE_SCOPES = ['ORG_UNIT', 'PROGRAMME', 'COHORT', 'COURSE_OFFERING', 'HOSTEL'] as const;
const SETTING = 'files.storageQuotaBytes'; // core (always on), managed by settings.tenant.manage

let h: Harness;
const run = randomBytes(3).toString('hex');
const roleIds: { scoped: string; viewer: string } = { scoped: '', viewer: '' };
const sessionOf = (res: { headers: Record<string, unknown> }) =>
  ([res.headers['set-cookie']].flat().filter(Boolean) as string[])
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('__Host-uv_sid='))!;

/**
 * A demo user whose grants of `identity.user.view` and `settings.tenant.manage` are at `scope` (with a resource id
 * unless INSTITUTION), plus `settings.tenant.view` institution-wide; signed in with MFA.
 */
async function userAt(scope: string): Promise<{ session: string; id: string }> {
  const tenantId = h.tenants.demo;
  const u = await h.makeUser('demo', { role: 'LECTURER' });
  const db = forTenant(h.shard, tenantId);
  await db.roleAssignment.create({
    data: {
      tenantId,
      userId: u.id,
      roleId: roleIds.scoped,
      scopeType: scope as 'INSTITUTION',
      scopeId: scope === 'INSTITUTION' ? null : randomUUID(),
    },
  });
  await db.roleAssignment.create({
    data: { tenantId, userId: u.id, roleId: roleIds.viewer, scopeType: 'INSTITUTION' },
  });
  const restricted = sessionOf(await h.login(HOSTS.demo, u.username));
  const begin = await h.call('POST', HOSTS.demo, '/api/v1/auth/mfa/totp/enrol', {
    cookie: restricted,
    body: { password: PASSWORD },
  });
  expect(begin.statusCode).toBe(200);
  const secret = base32Decode(begin.json().secret);
  const confirm = await h.call('POST', HOSTS.demo, '/api/v1/auth/mfa/totp/confirm', {
    cookie: restricted,
    body: { code: totpCode(secret) },
  });
  expect(confirm.statusCode).toBe(200);
  await resetReplayGuard(h.shard, tenantId, u.id);
  return { session: sessionOf(confirm), id: u.id };
}

beforeAll(async () => {
  h = await createHarness();
  const db = forTenant(h.shard, h.tenants.demo);
  const role = (key: string, permissions: string[]) =>
    db.role.create({ data: { tenantId: h.tenants.demo, key, name: key, permissions } });
  roleIds.scoped = (
    await role(`PS18_SCOPED_${run}`, ['identity.user.view', 'settings.tenant.manage'])
  ).id;
  roleIds.viewer = (await role(`PS18_VIEWER_${run}`, ['settings.tenant.view'])).id;
});

afterAll(async () => {
  const db = forTenant(h.shard, h.tenants.demo);
  await db.roleAssignment.deleteMany({ where: { roleId: { in: Object.values(roleIds) } } });
  await db.role.deleteMany({ where: { id: { in: Object.values(roleIds) } } });
  await h.close();
});

describe('[PS4][PS1] a grant at a resource scope gives nothing institution-wide', () => {
  for (const scope of RESOURCE_SCOPES)
    it(`[PS4][PS1] ${scope}: GET /users is 403, /auth/me doesn't list the scoped permissions, and settings' canManage is false`, async () => {
      const { session } = await userAt(scope);
      const users = await h.call('GET', HOSTS.demo, '/api/v1/users', { cookie: session });
      expect([users.statusCode, users.json().code]).toEqual([403, 'auth.forbidden']);
      const me = await h.call('GET', HOSTS.demo, '/api/v1/auth/me', { cookie: session });
      expect(me.statusCode).toBe(200);
      expect(me.json().permissions).not.toContain('identity.user.view');
      expect(me.json().permissions).not.toContain('settings.tenant.manage');
      expect(me.json().permissions).toContain('settings.tenant.view');
      const setting = await h.call('GET', HOSTS.demo, `/api/v1/settings/${SETTING}`, {
        cookie: session,
      });
      expect([setting.statusCode, setting.json().canManage]).toEqual([200, false]);
    });

  it('[PS4][PS1] control: the same grants at INSTITUTION give 200, are listed, and canManage is true', async () => {
    const { session } = await userAt('INSTITUTION');
    expect((await h.call('GET', HOSTS.demo, '/api/v1/users', { cookie: session })).statusCode).toBe(
      200,
    );
    const me = await h.call('GET', HOSTS.demo, '/api/v1/auth/me', { cookie: session });
    expect(me.json().permissions).toEqual(
      expect.arrayContaining([
        'identity.user.view',
        'settings.tenant.manage',
        'settings.tenant.view',
      ]),
    );
    const setting = await h.call('GET', HOSTS.demo, `/api/v1/settings/${SETTING}`, {
      cookie: session,
    });
    expect([setting.statusCode, setting.json().canManage]).toEqual([200, true]);
  });

  it("[PS4] cross-tenant: an institution grant in demo gives nothing on test-poly's host", async () => {
    const { session } = await userAt('INSTITUTION');
    const res = await h.call('GET', HOSTS.poly, '/api/v1/users', { cookie: session });
    expect(res.statusCode).toBe(401);
  });
});

describe('[PS5] the database refuses a malformed assignment (D4)', () => {
  const cases: [string, string, string | null][] = [
    ['an INSTITUTION assignment naming a resource', 'INSTITUTION', randomUUID()],
    ['a resource-scoped assignment naming none', 'ORG_UNIT', null],
  ];

  it('[PS5] as the app role and as the migrator, each is refused by the CHECK constraint', async () => {
    const tenantId = h.tenants.demo;
    const u = await h.makeUser('demo', { role: 'LECTURER' });
    const migrator = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
    try {
      for (const [client, who] of [
        [h.shard, 'app'],
        [migrator, 'migrator'],
      ] as const)
        for (const [what, scopeType, scopeId] of cases) {
          let message = 'no error';
          try {
            await withTenantTx(client, tenantId, (tx) =>
              tx.$executeRawUnsafe(
                `INSERT INTO role_assignment (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"ScopeType", $5::uuid)`,
                tenantId,
                u.id,
                roleIds.viewer,
                scopeType,
                scopeId,
              ),
            );
          } catch (err) {
            message = (err as Error).message;
          }
          expect([who, what, message]).toEqual([
            who,
            what,
            expect.stringContaining('role_assignment_scope_id_matches_type'),
          ]);
        }
    } finally {
      await migrator.$disconnect();
    }
  });
});
