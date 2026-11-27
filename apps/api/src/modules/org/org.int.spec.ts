/**
 * Spec 0042 (P2-S1): the org tree against the real database, through the tenant API. Unit types projected from the
 * profile; the tree's rules (and the database's own checks behind them); moves with step-up, If-Match and both ends in
 * scope; effective dates and "as at"; codes reserved for ever once locked; the ORG_UNIT scope from the loaded unit;
 * the history append-only. Institutions here are their own (slug `org-…`), removed at the end.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, forTenant, projectUnitTypes, seedTenantBase, withTenantTx, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { lagosToday, TEMPLATES } from '@univarse/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { hashPassword } from '../identity/password.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'org-';
const PASSWORD = 'Correct-Horse-Battery-9';

let app: NestFastifyApplication;
let migrator: PlatformClient;
/** The tenant pool as the migrator (fixtures), and as the app's own role (the database's rules as the app meets them). */
let shard: TenantShardClient;
let appShard: TenantShardClient;
let poolId: string;

const today = () => lagosToday(new Date());
/** `n` days before today, as `YYYY-MM-DD`. */
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;

interface Res {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: Record<string, unknown> & { code?: string; data?: unknown[] };
  setCookie: string[];
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

async function call(host: string, method: Method, url: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      remoteAddress: ip(),
      headers: {
        host,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const set = res.headers['set-cookie'];
  const body = res.body ? (JSON.parse(res.body) as Res['body']) : {};
  return { status: res.statusCode, headers: res.headers, body, setCookie: Array.isArray(set) ? set : set ? [set] : [] };
}
const cookie = (r: Res, name: string) => (r.setCookie.find((c) => c.startsWith(`${name}=`) && c.length > name.length + 10) ?? '').split(';')[0] ?? '';

interface Person {
  id: string;
  username: string;
  secret: Buffer | null;
}

const TYPE_KEYS = ['faculty', 'department', 'section', 'directorate', 'school', 'unit'] as const;
type TypeKey = (typeof TYPE_KEYS)[number];

interface Inst {
  id: string;
  host: string;
  legalName: string;
  root: string;
  types: Readonly<Record<TypeKey, string>>;
  /** System roles by key, and a custom role holding the three org permissions. */
  roles: Map<string, string>;
}

async function institution(): Promise<Inst> {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const legalName = `Org Test University ${slug}`;
  const t = await migrator.tenant.create({ data: { slug, legalName, shortName: 'OTU', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE', shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await provisionTenantKey(migrator, keyProviderFrom(loadConfig({ ...process.env, NODE_ENV: 'test' })), t.id);
  const roles = await withTenantTx(shard, t.id, async (tx) => {
    const ids = await seedTenantBase(tx, t.id, 'Stored Root Name');
    await projectUnitTypes(tx, t.id, TEMPLATES.university.profile.unitTypes);
    const scoped = await tx.role.create({ data: { tenantId: t.id, key: 'UNIT_MANAGER', name: 'Unit manager', permissions: ['org.unit.view', 'org.unit.manage', 'org.unit.restructure'] }, select: { id: true } });
    ids.set('UNIT_MANAGER', scoped.id);
    return ids;
  });
  const db = forTenant(shard, t.id);
  const root = (await db.orgUnit.findFirstOrThrow({ where: { parentId: null }, select: { id: true } })).id;
  const byKey = new Map((await db.unitType.findMany({ select: { id: true, key: true } })).map((x) => [x.key, x.id]));
  const types = Object.fromEntries(
    TYPE_KEYS.map((k) => {
      const id = byKey.get(k);
      if (!id) throw new Error(`no unit type ${k}`);
      return [k, id];
    }),
  ) as Record<TypeKey, string>;
  return { id: t.id, host, legalName, root, types, roles };
}

/** A person holding `role` at the institution, or scoped to a unit. */
async function person(i: Inst, role: string, opts: { mfa?: boolean; unit?: string } = {}): Promise<Person> {
  const db = forTenant(shard, i.id);
  const username = `OT-${randomBytes(3).toString('hex').toUpperCase()}`;
  const u = await db.userAccount.create({ data: { tenantId: i.id, username, displayName: `Person ${username}`, status: 'ACTIVE', email: `${username.toLowerCase()}@test.local`, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  const roleId = i.roles.get(role);
  if (!roleId) throw new Error(`no role ${role}`);
  await db.roleAssignment.create({ data: { tenantId: i.id, userId: u.id, roleId, ...(opts.unit ? { scopeType: 'ORG_UNIT', scopeId: opts.unit } : { scopeType: 'INSTITUTION' }) } });
  return { id: u.id, username, secret: opts.mfa === false ? null : await enrolTestTotp(shard, i.id, u.id) };
}

async function signIn(i: Inst, p: Person, stepUp = false): Promise<string> {
  const login = await call(i.host, 'POST', '/api/v1/auth/login', { body: { username: p.username, password: PASSWORD } });
  expect(login.status).toBe(200);
  let sid = cookie(login, '__Host-uv_sid');
  if (p.secret) {
    await resetReplayGuard(shard, i.id, p.id);
    const v = await call(i.host, 'POST', '/api/v1/auth/mfa/verify', { cookie: cookie(login, '__Host-uv_mfa'), body: { code: totpCode(p.secret) } });
    expect(v.status).toBe(200);
    sid = cookie(v, '__Host-uv_sid');
    if (stepUp) {
      await resetReplayGuard(shard, i.id, p.id);
      const up = await call(i.host, 'POST', '/api/v1/auth/step-up', { cookie: sid, body: { password: PASSWORD, code: totpCode(p.secret) } });
      expect(up.status).toBe(200);
      sid = cookie(up, '__Host-uv_sid');
    }
  }
  return sid;
}

/** Creates a unit through the API; returns its id and ETag. */
async function create(i: Inst, sid: string, body: Record<string, unknown>, key = randomUUID()): Promise<{ id: string; etag: string; res: Res }> {
  const res = await call(i.host, 'POST', '/api/v1/org/units', { cookie: sid, body, headers: { 'idempotency-key': key } });
  return { id: typeof res.body.id === 'string' ? res.body.id : '', etag: String(res.headers.etag ?? ''), res };
}
const etagOf = async (i: Inst, sid: string, id: string) => String((await call(i.host, 'GET', `/api/v1/org/units/${id}`, { cookie: sid })).headers.etag);
const listIds = async (i: Inst, sid: string, query = '') => ((await call(i.host, 'GET', `/api/v1/org/units${query}`, { cookie: sid })).body.data as { id: string }[]).map((u) => u.id);

beforeAll(async () => {
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  appShard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  await Promise.all([shard.$disconnect(), appShard.$disconnect(), migrator.$disconnect()]);
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await app.close();
});

describe('[Q1, Q2] unit types', () => {
  it('are the profile’s, edited one at a time: renamed, extended, archived, never re-kinded; a changed rule never moves a unit', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const sid = await signIn(i, admin, true);
    const list = await call(i.host, 'GET', '/api/v1/org/unit-types', { cookie: sid });
    expect(list.status).toBe(200);
    const rows = list.body.data as { key: string; mayContain: string[]; version: number; kind: string; name: string; status: string }[];
    expect(rows.map((t) => t.key)).toEqual(TEMPLATES.university.profile.unitTypes.map((t) => t.key));
    expect(rows.find((t) => t.key === 'faculty')?.mayContain).toContain('department');
    expect(list.body.canManage).toBe(true);

    // A department under a faculty, then the rule removed: the department stays, flagged; a new one is refused.
    const fac = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Science', code: 'SCI' });
    const dep = await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Computer Science', code: 'CSC' });
    expect([fac.res.status, dep.res.status]).toEqual([201, 201]);
    const faculty = rows.find((t) => t.key === 'faculty')!;
    const save = (key: string, body: Record<string, unknown>, version: number) => call(i.host, 'PUT', `/api/v1/org/unit-types/${key}`, { cookie: sid, body, headers: { 'if-match': `"v${String(version)}"` } });
    const removed = await save('faculty', { name: 'Academic Faculty', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: faculty.mayContain.filter((k) => k !== 'department') }, faculty.version);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ key: 'faculty', name: 'Academic Faculty', version: faculty.version + 1 });
    const tree = (await call(i.host, 'GET', '/api/v1/org/units', { cookie: sid })).body.data as { id: string; followsRules: boolean }[];
    expect(tree.find((u) => u.id === dep.id)?.followsRules).toBe(false);
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Physics' })).res.body.code).toBe('org.unit.type_not_allowed');

    // Stale, a changed kind, an unknown child, a taken name: refused.
    expect((await save('faculty', { name: 'Academic Faculty', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: [] }, faculty.version)).status).toBe(412);
    expect((await save('faculty', { name: 'Academic Faculty', kind: 'RESEARCH', status: 'ACTIVE', mayContain: [] }, faculty.version + 1)).body.code).toBe('org.unit_type.kind_fixed');
    expect((await save('faculty', { name: 'Academic Faculty', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: ['no_such_type'] }, faculty.version + 1)).body.code).toBe('org.unit_type.unknown_child');
    expect((await save('teaching_hospital', { name: 'Department', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: [] }, 0)).body.code).toBe('org.unit_type.name_taken');

    // A new type of the institution's own, then archived: no new unit of it.
    const added = await save('teaching_hospital', { name: 'Teaching Hospital', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: ['department'] }, 0);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ key: 'teaching_hospital', version: 1, mayContain: ['department'], units: 0 });
    expect((await save('teaching_hospital', { name: 'Teaching Hospital', kind: 'ACADEMIC', status: 'ARCHIVED', mayContain: ['department'] }, 1)).status).toBe(200);
    expect((await create(i, sid, { parentId: i.root, typeId: String(added.body.id), name: 'UTH' })).res.body.code).toBe('org.unit.type_archived');
    expect((await save('Bad-Key', { name: 'X', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: [] }, 0)).status).toBe(404);
  });
});

describe('[Q3, Q4, Q8, Q-A1, Q-A2] creating units', () => {
  it('follows the types’ rules, shows the root as the institution, takes an optional code, and answers a replay with the same unit', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const other = await person(i, 'REGISTRAR');
    const sid = await signIn(i, admin);
    const otherSid = await signIn(i, other);

    const key = randomUUID();
    const fac = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Science', code: ' sci ' }, key);
    expect(fac.res.status).toBe(201);
    expect(fac.res.body).toMatchObject({ code: 'SCI', name: 'Faculty of Science', state: 'ACTIVE', version: 0, ancestors: [{ id: i.root, name: i.legalName, code: null }], can: { manage: true, restructure: true } });
    expect(fac.etag).toBe('"v0"');
    const replay = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Anything else' }, key);
    expect([replay.res.status, replay.id, replay.res.headers['idempotent-replayed']]).toEqual([201, fac.id, 'true']);
    expect((await create(i, otherSid, { parentId: i.root, typeId: i.types.faculty, name: 'X' }, key)).res.body.code).toBe('org.unit.key_reused');
    expect((await call(i.host, 'POST', '/api/v1/org/units', { cookie: sid, body: { parentId: i.root, typeId: i.types.faculty, name: 'No key' } })).status).toBe(400);

    // The root: the institution's legal name, no code shown, no type.
    const rootView = await call(i.host, 'GET', `/api/v1/org/units/${i.root}`, { cookie: sid });
    expect(rootView.body).toMatchObject({ id: i.root, name: i.legalName, code: null, type: null, parentId: null, children: { open: 1, archived: 0 } });

    // A department may have no code yet; a code is never reused; a bad one is refused; the type's rules hold.
    const nocode = await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Commercial Law' });
    expect([nocode.res.status, nocode.res.body.code]).toEqual([201, null]);
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Dup', code: 'SCI' })).res.body.code).toBe('org.unit.code_taken');
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Bad', code: 'C-S' })).res.body.code).toBe('org.unit.code_invalid');
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.directorate, name: 'Works' })).res.body.code).toBe('org.unit.type_not_allowed');
    expect((await create(i, sid, { parentId: i.root, typeId: i.types.directorate, name: 'Works', code: 'WKS' })).res.status).toBe(201);
    expect((await create(i, sid, { parentId: randomUUID(), typeId: i.types.faculty, name: 'Nowhere' })).res.body.code).toBe('org.unit.parent_not_found');
    expect((await create(i, sid, { parentId: i.root, typeId: randomUUID(), name: 'No type' })).res.body.code).toBe('org.unit.type_not_found');

    // ROOT is reserved: no unit can take it.
    expect((await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Root?', code: 'ROOT' })).res.body.code).toBe('org.unit.code_taken');

    // The audit names the code `acronym` (a key naming a code is redacted).
    const audit = await forTenant(shard, i.id).auditEvent.findFirstOrThrow({ where: { action: 'org.unit.created', entityId: fac.id }, select: { actorId: true, after: true } });
    expect(audit).toMatchObject({ actorId: admin.id, after: { acronym: 'SCI', name: 'Faculty of Science', kinds: ['CREATED'], effectiveFrom: today() } });
  });
});

describe('[Q5, Q7] statuses and dates', () => {
  it('deactivates, archives leaf first, reactivates under an active parent; dates are never in the future or out of order', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const sid = await signIn(i, admin, true);
    const fac = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Arts', code: 'ART', effectiveFrom: daysAgo(30) });
    const dep = await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'History', code: 'HIS', effectiveFrom: daysAgo(20) });
    expect([fac.res.status, dep.res.status]).toEqual([201, 201]);
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Tomorrow', effectiveFrom: daysAgo(-1) })).res.body.code).toBe('org.unit.effective_date_future');
    // Before its parent's creation: out of order.
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Early', effectiveFrom: daysAgo(31) })).res.body.code).toBe('org.unit.effective_date_out_of_order');

    const act = (id: string, what: string, etag: string, body: Record<string, unknown> = {}) => call(i.host, 'POST', `/api/v1/org/units/${id}/${what}`, { cookie: sid, body, headers: { 'if-match': etag } });
    // Out of order against the unit's own last change.
    expect((await act(dep.id, 'deactivate', dep.etag, { effectiveFrom: daysAgo(25) })).body.code).toBe('org.unit.effective_date_out_of_order');
    const off = await act(fac.id, 'deactivate', fac.etag);
    expect([off.status, off.body.state]).toEqual([200, 'INACTIVE']);
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Under inactive' })).res.body.code).toBe('org.unit.parent_not_active');
    expect((await act(fac.id, 'archive', String(off.headers.etag), { reason: 'Merged' })).body).toMatchObject({ code: 'org.unit.has_open_children' });
    const depArchived = await act(dep.id, 'archive', dep.etag, { reason: 'Closed' });
    expect(depArchived.body.state).toBe('ARCHIVED');
    const facArchived = await act(fac.id, 'archive', String(off.headers.etag), { reason: 'Merged' });
    expect(facArchived.body.state).toBe('ARCHIVED');
    expect(await listIds(i, sid)).not.toContain(fac.id);
    expect(await listIds(i, sid, '?includeArchived=true')).toEqual(expect.arrayContaining([fac.id, dep.id]));
    // A child back only under an active parent; the parent back first.
    expect((await act(dep.id, 'reactivate', String(depArchived.headers.etag))).body.code).toBe('org.unit.parent_not_active');
    expect((await act(fac.id, 'reactivate', String(facArchived.headers.etag))).body.state).toBe('ACTIVE');
    expect((await act(dep.id, 'reactivate', String(depArchived.headers.etag))).body.state).toBe('ACTIVE');
    // The root is fixed.
    expect((await act(i.root, 'deactivate', await etagOf(i, sid, i.root))).body.code).toBe('org.unit.root_fixed');
    // Archive needs a reason (400) and If-Match (428).
    expect((await act(dep.id, 'archive', await etagOf(i, sid, dep.id))).status).toBe(400);
    expect((await call(i.host, 'POST', `/api/v1/org/units/${dep.id}/deactivate`, { cookie: sid, body: {} })).status).toBe(428);
  });
});

describe('[Q11, Q6] moves and the tree as at a date', () => {
  it('moves a subtree in one transaction with step-up, refuses cycles and stale versions, and reads the tree as it was', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const plain = await signIn(i, admin);
    const sid = await signIn(i, admin, true);
    const sci = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Science', code: 'SCI', effectiveFrom: daysAgo(40) });
    const cmp = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Computing', code: 'CMP', effectiveFrom: daysAgo(40) });
    const csc = await create(i, sid, { parentId: sci.id, typeId: i.types.department, name: 'Computer Science', code: 'CSC', effectiveFrom: daysAgo(30) });
    const lab = await create(i, sid, { parentId: csc.id, typeId: i.types.section, name: 'Lab', code: 'LAB', effectiveFrom: daysAgo(30) });
    const move = (id: string, body: Record<string, unknown>, etag: string, cookieValue = sid) => call(i.host, 'POST', `/api/v1/org/units/${id}/move`, { cookie: cookieValue, body, headers: { 'if-match': etag } });

    expect((await move(csc.id, { parentId: cmp.id, reason: 'Computing faculty' }, csc.etag, plain)).status).toBe(428);
    expect((await move(csc.id, { parentId: cmp.id, reason: 'Computing faculty' }, '"v9"')).status).toBe(412);
    expect((await move(csc.id, { parentId: cmp.id }, csc.etag)).status).toBe(400); // a reason is required
    expect((await move(sci.id, { parentId: lab.id, reason: 'Loop' }, sci.etag)).body.code).toBe('org.unit.cycle');
    expect((await move(i.root, { parentId: sci.id, reason: 'Root' }, await etagOf(i, sid, i.root))).body.code).toBe('org.unit.root_fixed');
    expect((await move(csc.id, { parentId: sci.id, reason: 'Same' }, csc.etag)).body.code).toBe('org.unit.same_parent');

    // Yesterday's rename, then today's move.
    const renamed = await call(i.host, 'PATCH', `/api/v1/org/units/${csc.id}`, { cookie: sid, body: { name: 'Department of Computer Science', effectiveFrom: daysAgo(1) }, headers: { 'if-match': csc.etag } });
    expect(renamed.status).toBe(200);
    const moved = await move(csc.id, { parentId: cmp.id, reason: 'Computing faculty' }, String(renamed.headers.etag));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ parentId: cmp.id, version: 2, ancestors: [{ id: i.root }, { id: cmp.id, code: 'CMP' }] });
    const paths = await forTenant(shard, i.id).orgUnit.findMany({ where: { id: { in: [csc.id, lab.id] } }, select: { id: true, path: true } });
    expect(Object.fromEntries(paths.map((p) => [p.id, p.path]))).toEqual({ [csc.id]: `/${i.root}/${cmp.id}/${csc.id}/`, [lab.id]: `/${i.root}/${cmp.id}/${csc.id}/${lab.id}/` });
    const audit = await forTenant(shard, i.id).auditEvent.findFirstOrThrow({ where: { action: 'org.unit.moved', entityId: csc.id }, select: { before: true, after: true, reason: true } });
    expect(audit).toMatchObject({ before: { parentId: sci.id }, after: { parentId: cmp.id, kinds: ['MOVED'], units: 2 }, reason: 'Computing faculty' });

    // As at: 35 days ago CSC didn't exist; 10 days ago it sat under Science with its first name; today under Computing.
    const asAt = async (d: string) => ((await call(i.host, 'GET', `/api/v1/org/units?asAt=${d}`, { cookie: sid })).body.data as { id: string; parentId: string; name: string }[]).find((u) => u.id === csc.id);
    expect(await asAt(daysAgo(35))).toBeUndefined();
    expect(await asAt(daysAgo(10))).toMatchObject({ parentId: sci.id, name: 'Computer Science' });
    expect(await asAt(today())).toMatchObject({ parentId: cmp.id, name: 'Department of Computer Science' });
    expect((await call(i.host, 'GET', `/api/v1/org/units?asAt=${daysAgo(-1)}`, { cookie: sid })).body.code).toBe('org.unit.effective_date_future');

    const history = (await call(i.host, 'GET', `/api/v1/org/units/${csc.id}/history`, { cookie: sid })).body.data as { kind: string; effectiveFrom: string; actor: { id: string } | null }[];
    expect(history.map((c) => [c.kind, c.effectiveFrom])).toEqual([
      ['MOVED', today()],
      ['RENAMED', daysAgo(1)],
      ['CREATED', daysAgo(30)],
    ]);
    expect(history[0]?.actor?.id).toBe(admin.id);
  });

  it('two crossing moves never both succeed (no cycle can be stored)', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const sid = await signIn(i, admin, true);
    const a = await create(i, sid, { parentId: i.root, typeId: i.types.unit, name: 'Unit A' });
    const b = await create(i, sid, { parentId: i.root, typeId: i.types.unit, name: 'Unit B' });
    // `unit` may contain only `section` in the profile; give it itself, so A and B may each go under the other.
    const unitType = ((await call(i.host, 'GET', '/api/v1/org/unit-types', { cookie: sid })).body.data as { key: string; version: number }[]).find((t) => t.key === 'unit')!;
    expect((await call(i.host, 'PUT', '/api/v1/org/unit-types/unit', { cookie: sid, body: { name: 'Unit', kind: 'ADMINISTRATIVE', status: 'ACTIVE', mayContain: ['section', 'unit'] }, headers: { 'if-match': `"v${String(unitType.version)}"` } })).status).toBe(200);
    const [x, y] = await Promise.all([
      call(i.host, 'POST', `/api/v1/org/units/${a.id}/move`, { cookie: sid, body: { parentId: b.id, reason: 'A under B' }, headers: { 'if-match': a.etag } }),
      call(i.host, 'POST', `/api/v1/org/units/${b.id}/move`, { cookie: sid, body: { parentId: a.id, reason: 'B under A' }, headers: { 'if-match': b.etag } }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 422]);
    expect([x.body.code, y.body.code].filter(Boolean)).toEqual(['org.unit.cycle']);
  });
});

describe('[Q9, Q10] retyping and the code lock', () => {
  it('a locked code is never corrected or freed: a dated change keeps the old one reserved, and the database holds it', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const sid = await signIn(i, admin, true);
    const fac = await create(i, sid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Science', code: 'SCI' });
    const dep = await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Computer Science', code: 'CMP' });
    const patch = (id: string, body: Record<string, unknown>, etag: string) => call(i.host, 'PATCH', `/api/v1/org/units/${id}`, { cookie: sid, body, headers: { 'if-match': etag } });

    // Unlocked: a correction, and the old code is free again.
    const fixed = await patch(dep.id, { code: 'csc' }, dep.etag);
    expect([fixed.status, fixed.body.code]).toEqual([200, 'CSC']);
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Reuses CMP', code: 'CMP' })).res.status).toBe(201);
    expect((await call(i.host, 'POST', `/api/v1/org/units/${dep.id}/code`, { cookie: sid, body: { code: 'CSX', reason: 'x' }, headers: { 'if-match': String(fixed.headers.etag) } })).body.code).toBe('org.unit.code_not_locked');

    // Retype: a faculty becomes a school (same kind, and a school may hold departments); never across kinds.
    const school = await patch(fac.id, { typeId: i.types.school }, fac.etag);
    expect(school.body).toMatchObject({ type: { key: 'school' } });
    expect((await patch(fac.id, { typeId: i.types.directorate }, String(school.headers.etag))).body.code).toBe('org.unit.kind_change');

    // Locked, as Phase 3's first matric number will lock it.
    await withTenantTx(shard, i.id, (tx) => tx.orgUnit.update({ where: { id: dep.id }, data: { codeLockedAt: new Date() } }));
    const etag = await etagOf(i, sid, dep.id);
    expect((await patch(dep.id, { code: 'CSY' }, etag)).body.code).toBe('org.unit.code_locked');
    const changed = await call(i.host, 'POST', `/api/v1/org/units/${dep.id}/code`, { cookie: sid, body: { code: 'COM', reason: 'Senate approved COM', effectiveFrom: today() }, headers: { 'if-match': etag } });
    expect(changed.body).toMatchObject({ code: 'COM', codeLocked: true });
    expect((await create(i, sid, { parentId: fac.id, typeId: i.types.department, name: 'Takes CSC?', code: 'CSC' })).res.body.code).toBe('org.unit.code_taken');
    const reserved = await forTenant(shard, i.id).orgUnitCode.findMany({ where: { unitId: dep.id }, select: { code: true }, orderBy: { code: 'asc' } });
    expect(reserved.map((r) => r.code)).toEqual(['COM', 'CSC']);

    // The database, as the app's own role: the lock can't be cleared, a locked reservation can't be released.
    const app = forTenant(appShard, i.id);
    await expect(app.orgUnit.update({ where: { id: dep.id }, data: { codeLockedAt: null } })).rejects.toThrow(/code lock is never cleared/);
    await expect(app.orgUnitCode.deleteMany({ where: { unitId: dep.id, code: 'CSC' } })).rejects.toThrow(/stays reserved/);
  });
});

describe('[Q6, Q5] the database’s own rules, as the app meets them', () => {
  it('no unit is deleted, the history is append-only, and a wrong path or a forbidden placement fails at commit', async () => {
    const i = await institution();
    const app = forTenant(appShard, i.id);
    await expect(app.orgUnit.deleteMany({ where: { id: i.root } })).rejects.toThrow(/permission denied/);
    await expect(app.orgUnitChange.updateMany({ data: { reason: 'tampered' } })).rejects.toThrow(/permission denied/);
    await expect(app.orgUnitChange.deleteMany({})).rejects.toThrow(/permission denied/);
    await expect(app.unitType.deleteMany({})).rejects.toThrow(/permission denied/);
    // A path that isn't the parent's plus its own id.
    await expect(
      withTenantTx(appShard, i.id, async (tx) => {
        await tx.orgUnit.create({ data: { tenantId: i.id, name: 'Stray', typeId: i.types.faculty, parentId: i.root, path: `/${randomUUID()}/`, kind: 'ACADEMIC', type: 'FACULTY' } });
      }),
    ).rejects.toThrow(/path must be its parent/);
    // A placement the types forbid (a directorate may not hold a faculty), written past the API.
    const dir = await withTenantTx(appShard, i.id, async (tx) => {
      const d = await tx.orgUnit.create({ data: { tenantId: i.id, name: 'Works', typeId: i.types.directorate, parentId: i.root, path: `/${i.root}/`, kind: 'ADMINISTRATIVE', type: 'UNIT' }, select: { id: true } });
      await tx.orgUnit.update({ where: { id: d.id }, data: { path: `/${i.root}/${d.id}/` } });
      await tx.orgUnitChange.create({ data: { tenantId: i.id, unitId: d.id, kind: 'CREATED', name: 'Works', typeId: i.types.directorate, parentId: i.root, state: 'ACTIVE', effectiveFrom: new Date(`${today()}T00:00:00Z`) } });
      return d.id;
    });
    await expect(
      withTenantTx(appShard, i.id, async (tx) => {
        const f = await tx.orgUnit.create({ data: { tenantId: i.id, name: 'Faculty in works', typeId: i.types.faculty, parentId: dir, path: `/${i.root}/${dir}/`, kind: 'ACADEMIC', type: 'FACULTY' }, select: { id: true } });
        await tx.orgUnit.update({ where: { id: f.id }, data: { path: `/${i.root}/${dir}/${f.id}/` } });
      }),
    ).rejects.toThrow(/may not contain its type/);
    // A code with no reservation.
    await expect(
      withTenantTx(appShard, i.id, async (tx) => {
        await tx.orgUnit.update({ where: { id: dir }, data: { code: 'ZZZ' } });
      }),
    ).rejects.toThrow(/ForeignKeyConstraintViolation|org_unit_code_reserved_fkey|foreign key/);
  });
});

describe('[Q13, Q12] the ORG_UNIT scope and the permissions', () => {
  it('a grant on a faculty covers its units and nothing else; a move needs both ends; out of scope is 404', async () => {
    const i = await institution();
    const admin = await person(i, 'INSTITUTION_ADMIN');
    const adminSid = await signIn(i, admin, true);
    const sci = await create(i, adminSid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Science', code: 'SCI' });
    const eng = await create(i, adminSid, { parentId: i.root, typeId: i.types.faculty, name: 'Faculty of Engineering', code: 'ENG' });
    const csc = await create(i, adminSid, { parentId: sci.id, typeId: i.types.department, name: 'Computer Science', code: 'CSC' });
    const mee = await create(i, adminSid, { parentId: eng.id, typeId: i.types.department, name: 'Mechanical', code: 'MEE' });

    const dean = await person(i, 'UNIT_MANAGER', { unit: sci.id });
    const sid = await signIn(i, dean, true);
    expect((await listIds(i, sid)).sort()).toEqual([sci.id, csc.id].sort());
    expect((await call(i.host, 'GET', `/api/v1/org/units/${csc.id}`, { cookie: sid })).body).toMatchObject({ id: csc.id, can: { manage: true, restructure: true } });
    for (const id of [eng.id, mee.id, i.root]) {
      expect((await call(i.host, 'GET', `/api/v1/org/units/${id}`, { cookie: sid })).status, id).toBe(404);
      expect((await call(i.host, 'GET', `/api/v1/org/units/${id}/history`, { cookie: sid })).status, id).toBe(404);
    }
    expect((await create(i, sid, { parentId: sci.id, typeId: i.types.department, name: 'Physics', code: 'PHY' })).res.status).toBe(201);
    expect((await create(i, sid, { parentId: eng.id, typeId: i.types.department, name: 'Civil' })).res.body.code).toBe('org.unit.parent_not_found');
    // A replay of the dean's own create answers while the unit is in their scope, and is 404 once it's moved out.
    const key = randomUUID();
    const mine = await create(i, sid, { parentId: sci.id, typeId: i.types.department, name: 'Chemistry', code: 'CHM' }, key);
    expect((await create(i, sid, { parentId: sci.id, typeId: i.types.department, name: 'Chemistry' }, key)).res.status).toBe(201);
    expect((await call(i.host, 'POST', `/api/v1/org/units/${mine.id}/move`, { cookie: adminSid, body: { parentId: eng.id, reason: 'To engineering' }, headers: { 'if-match': mine.etag } })).status).toBe(200);
    expect((await create(i, sid, { parentId: sci.id, typeId: i.types.department, name: 'Chemistry' }, key)).res.status).toBe(404);
    // Out of, or into, the scope: refused as 404, whichever end is outside.
    expect((await call(i.host, 'POST', `/api/v1/org/units/${csc.id}/move`, { cookie: sid, body: { parentId: eng.id, reason: 'x' }, headers: { 'if-match': csc.etag } })).body.code).toBe('org.unit.parent_not_found');
    expect((await call(i.host, 'POST', `/api/v1/org/units/${mee.id}/move`, { cookie: sid, body: { parentId: sci.id, reason: 'x' }, headers: { 'if-match': mee.etag } })).status).toBe(404);
    expect((await call(i.host, 'PATCH', `/api/v1/org/units/${mee.id}`, { cookie: sid, body: { name: 'Taken over' }, headers: { 'if-match': mee.etag } })).status).toBe(404);
    // Unit types are the institution's: a scoped grant doesn't reach them (and this role doesn't hold the permission).
    expect((await call(i.host, 'PUT', '/api/v1/org/unit-types/faculty', { cookie: sid, body: { name: 'F', kind: 'ACADEMIC', status: 'ACTIVE', mayContain: [] }, headers: { 'if-match': '"v1"' } })).status).toBe(403);
    expect((await call(i.host, 'GET', '/api/v1/org/unit-types', { cookie: sid })).body.canManage).toBe(false);

    // A lecturer sees the tree, changes nothing; a student sees nothing.
    const lecturer = await signIn(i, await person(i, 'LECTURER', { mfa: false }));
    expect((await call(i.host, 'GET', '/api/v1/org/units', { cookie: lecturer })).status).toBe(200);
    expect((await create(i, lecturer, { parentId: sci.id, typeId: i.types.department, name: 'Nope' })).res.status).toBe(403);
    const student = await signIn(i, await person(i, 'STUDENT', { mfa: false }));
    expect((await call(i.host, 'GET', '/api/v1/org/units', { cookie: student })).status).toBe(403);
    // Management (read-only) may read the structure and its history (Q12).
    const viewer = await signIn(i, await person(i, 'MANAGEMENT_VIEWER', { mfa: false }));
    expect((await call(i.host, 'GET', `/api/v1/org/units/${csc.id}/history`, { cookie: viewer })).status).toBe(200);
  });

  it('another institution’s units are never reachable, by id or in a list', async () => {
    const a = await institution();
    const b = await institution();
    const aSid = await signIn(a, await person(a, 'INSTITUTION_ADMIN'));
    const bSid = await signIn(b, await person(b, 'INSTITUTION_ADMIN'));
    const unit = await create(a, aSid, { parentId: a.root, typeId: a.types.faculty, name: 'A only', code: 'AON' });
    expect((await call(b.host, 'GET', `/api/v1/org/units/${unit.id}`, { cookie: bSid })).status).toBe(404);
    expect(await listIds(b, bSid)).not.toContain(unit.id);
    expect((await create(b, bSid, { parentId: unit.id, typeId: b.types.department, name: 'Under A' })).res.body.code).toBe('org.unit.parent_not_found');
    // Codes are per institution: B may use A's.
    expect((await create(b, bSid, { parentId: b.root, typeId: b.types.faculty, name: 'B too', code: 'AON' })).res.status).toBe(201);
  });
});
