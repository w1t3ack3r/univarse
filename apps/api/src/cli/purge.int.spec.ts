/**
 * Spec 0038 Q9–Q14, PR C (A7, A12, T36): an archived institution's purge against the real databases and storage. The
 * console's half through the platform API's HTTP stack (the `tenant.purge` approval, two people, the authorisation, the
 * institution's page, the inbox, the extension refused once begun); the job's half through `cli/purge.ts`'s own
 * functions, as the migrator, as the `purge` job runs them. The host's keys step is the key-destruction protocol
 * (spec 0020, tested with its ledger in tools/stack); here the institution's data keys are marked destroyed as a
 * committed destruction leaves them. Institutions here are their own (slug `prg-…`), removed at the end.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PutObjectCommand, S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { canonicalJson } from '@univarse/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { hashPassword } from '../modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../modules/identity/totp.js';
import { PlatformCredentials } from '../platform/identity/credentials.js';
import { createPlatformApp } from '../platform/platform-app.js';
import { CONSOLE_DB } from '../platform/platform-config.js';
import { platformTestConfig } from '../testing/platform-env.js';
import { pruneTestTenants } from '../testing/tenant-cleanup.js';
import { begin, check, facts, finish, keysDone, objects, platformRows, PURGE_TABLE_ORDER, PURGED_PLATFORM_TABLES, PurgeRefused, rows, type Storage } from './purge.js';

const rootEnv = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'prg-';
const PASSWORD = 'Correct-Horse-Battery-9';
const CONSOLE = 'console.univarse.localhost';
const DAY = 86_400_000;
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT';

let consoleApp: NestFastifyApplication;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let shard: TenantShardClient;
let creds: PlatformCredentials;
let poolId: string;
let storage: Storage;
const staff: string[] = [];
const cookies = new Map<string, string>();

const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Res {
  status: number;
  body: Record<string, unknown>;
  setCookie: string[];
}

async function cons(method: 'GET' | 'POST', url: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const res = await consoleApp
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/platform/v1${url}`,
      remoteAddress: ip(),
      headers: {
        host: CONSOLE,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [] };
}
const pick = (r: Res, name: string) => `${name}=${(r.setCookie.find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? ''}`;

/** A member of `role`, signed in with an authenticator and stepped up; `key` names a distinct person. */
async function as(role: Role, key: string = role): Promise<{ cookie: string; id: string }> {
  const known = cookies.get(key);
  if (known) return { cookie: known.split('|')[0] ?? '', id: known.split('|')[1] ?? '' };
  const email = `${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  const { id } = await consoleDb.platformUser.create({ data: { email, displayName: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  staff.push(id);
  let secret = '';
  await consoleDb.$transaction(async (tx) => {
    secret = (await creds.beginFactor(tx, { id, email })).secret;
    expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
  });
  const login = await cons('POST', '/auth/login', { body: { email, password: PASSWORD } });
  const mfa = await cons('POST', '/auth/mfa', { cookie: pick(login, '__Host-uv_console_mfa'), body: { code: totp(secret, 0) } });
  expect(mfa.status).toBe(200);
  const up = await cons('POST', '/me/step-up', { cookie: pick(mfa, '__Host-uv_console_sid'), body: { code: totp(secret, 1) } });
  expect(up.status).toBe(204);
  const cookie = pick(up, '__Host-uv_console_sid');
  cookies.set(key, `${cookie}|${id}`);
  return { cookie, id };
}

/** An archived institution with a data key, people, an audit trail, files in every bucket, and platform rows. */
async function institution(status: 'ARCHIVED' | 'ACTIVE' = 'ARCHIVED', slug = `${PREFIX}${randomBytes(4).toString('hex')}`) {
  const t = await migrator.tenant.create({ data: { slug, legalName: `Purged College ${slug}`, shortName: 'PC', type: 'COLLEGE_OF_EDUCATION', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: `${slug}.univarse.localhost`, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await migrator.tenantProduct.create({ data: { tenantId: t.id, product: 'admissions', entitled: true } });
  await migrator.tenantBranding.create({ data: { tenantId: t.id, primaryColor: '#123456' } });
  await provisionTenantKey(migrator, keyProviderFrom(loadConfig({ ...process.env, NODE_ENV: 'test' })), t.id);
  const db = forTenant(shard, t.id);
  const root = await db.orgUnit.create({ data: { tenantId: t.id, code: 'ROOT', name: 'Root', kind: 'ACADEMIC', type: 'INSTITUTION', path: '/' }, select: { id: true } });
  const fac = await db.orgUnit.create({ data: { tenantId: t.id, code: 'FAC', name: 'Faculty', kind: 'ACADEMIC', type: 'FACULTY', parentId: root.id, path: `/${root.id}/` }, select: { id: true } });
  await db.orgUnit.create({ data: { tenantId: t.id, code: 'DEP', name: 'Department', kind: 'ACADEMIC', type: 'DEPARTMENT', parentId: fac.id, path: `/${root.id}/${fac.id}/` } });
  const role = await db.role.create({ data: { tenantId: t.id, key: 'STUDENT', name: 'Student', isSystem: true, permissions: [] }, select: { id: true } });
  for (let i = 0; i < 3; i++) {
    const u = await db.userAccount.create({ data: { tenantId: t.id, username: `PG-${randomBytes(3).toString('hex').toUpperCase()}`, displayName: 'Purged Person', status: 'ACTIVE' }, select: { id: true } });
    await db.roleAssignment.create({ data: { tenantId: t.id, userId: u.id, roleId: role.id, scopeType: 'INSTITUTION' } });
    await db.session.create({ data: { tenantId: t.id, userId: u.id, tokenHash: randomBytes(32), idleExpiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() + DAY) } });
  }
  await db.auditEvent.create({ data: { tenantId: t.id, seq: 1n, actorType: 'SYSTEM', action: 'test.event', entityType: 'test', prevHash: new Uint8Array(32), hash: randomBytes(32) } });
  await db.setting.create({ data: { tenantId: t.id, key: 'test.key', value: 1 } });
  for (const Bucket of storage.buckets) {
    for (const name of ['a', 'b']) await storage.s3.send(new PutObjectCommand({ Bucket, Key: `tenants/${t.id}/x/${name}`, Body: 'x' }));
  }
  return { id: t.id, slug };
}

/** What the keys step leaves: every data key destroyed (the protocol's committed destruction). */
const destroyKeys = (tenantId: string) => migrator.tenantDataKey.updateMany({ where: { tenantId }, data: { destroyedAt: new Date(), status: 'DESTROYED', wrappedDek: null } });

const ask = (cookie: string, t: { id: string; slug: string }) => cons('POST', '/approvals', { cookie, body: { kind: 'tenant.purge', payload: { tenantId: t.id, slug: t.slug }, reason: 'The institution left and its window is over' } });
const approve = (cookie: string, id: string, payload: Record<string, unknown>) =>
  cons('POST', `/approvals/${id}/approve`, { cookie, body: { payloadHash: createHash('sha256').update(canonicalJson(payload)).digest('hex') } });

/** Asks as an owner and approves as a super admin: the authorisation. */
async function authorised(t: { id: string; slug: string }): Promise<string> {
  const asked = await ask((await as('OWNER')).cookie, t);
  expect(asked.status).toBe(201);
  const id = String(asked.body.id);
  const ok = await approve((await as('SUPER_ADMIN')).cookie, id, { tenantId: t.id, slug: t.slug });
  expect(ok.body.status).toBe('EXECUTED');
  return id;
}

const tenantRows = async (tenantId: string) => {
  const out: Record<string, number> = {};
  for (const table of PURGE_TABLE_ORDER) {
    const [r] = await shard.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1::uuid`, tenantId);
    });
    out[table] = r?.n ?? 0;
  }
  return out;
};
const keysIn = async (Bucket: string, tenantId: string) => (await storage.s3.send(new ListObjectsV2Command({ Bucket, Prefix: `tenants/${tenantId}/` }))).KeyCount ?? 0;
const refusedWith = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof PurgeRefused) return e.why;
    throw e;
  }
};

beforeAll(async () => {
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = consoleApp.get(CONSOLE_DB);
  creds = consoleApp.get(PlatformCredentials);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  storage = {
    s3: new S3Client({ endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env['S3_SECRET_KEY'] ?? '' } }),
    buckets: ['uv-quarantine', 'uv-clean', 'uv-exports'],
  };
  // Both people before anyone asks: a request needs someone else who could approve it (spec 0037 Q5), and CI's
  // database starts with no members at all.
  await as('OWNER');
  await as('SUPER_ADMIN');
});

afterAll(async () => {
  await consoleDb.platformSession.updateMany({ where: { userId: { in: staff }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: staff } }, data: { role: 'READ_ONLY', isActive: false } });
  for (const t of await migrator.tenant.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })) {
    for (const Bucket of storage.buckets) {
      const page = await storage.s3.send(new ListObjectsV2Command({ Bucket, Prefix: `tenants/${t.id}/` }));
      for (const o of page.Contents ?? []) if (o.Key) await storage.s3.send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket, Key: o.Key }));
    }
  }
  storage.s3.destroy();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await shard.$disconnect();
  await migrator.$disconnect();
  await consoleApp.close();
});

describe('[Q9, T36] asking and approving, in the console', () => {
  it('an archived institution only, two people, the shown hash naming it; the authorisation recorded and on its page', async () => {
    const t = await institution();
    const owner = await as('OWNER');
    expect((await ask((await as('SUPPORT')).cookie, t)).status).toBe(404);
    expect((await ask(owner.cookie, await institution('ACTIVE'))).body.code).toBe('tenant.not_purgeable');
    // The slug must be the institution's own: a mismatch names nothing.
    expect((await ask(owner.cookie, { id: t.id, slug: `${PREFIX}someone-else` })).status).toBe(404);
    const asked = await ask(owner.cookie, t);
    expect(asked.status).toBe(201);
    const id = String(asked.body.id);
    expect((await approve(owner.cookie, id, { tenantId: t.id, slug: t.slug })).body.code).toBe('approval.own_request');
    // A hash for another institution's payload is refused: the approver approves exactly what they were shown.
    expect((await approve((await as('SUPER_ADMIN')).cookie, id, { tenantId: t.id, slug: 'prg-other' })).body.code).toBe('approval.payload_changed');
    expect((await approve((await as('SUPER_ADMIN')).cookie, id, { tenantId: t.id, slug: t.slug })).body.status).toBe('EXECUTED');
    const audit = await migrator.platformAuditEvent.findFirst({ where: { tenantId: t.id, action: 'platform.tenant.purge_authorised' } });
    expect(audit?.metadata).toMatchObject({ approvalId: id, slug: t.slug });
    // With an authorisation standing, another request is refused.
    expect((await ask(owner.cookie, t)).body.code).toBe('approval.not_applicable');
    const page = (await cons('GET', `/tenants/${t.id}`, { cookie: owner.cookie })).body.purge as Record<string, unknown>;
    expect(page).toMatchObject({ request: { approvalId: id, status: 'EXECUTED' }, secondPersonAvailable: true, run: null });
    expect((page.request as Record<string, unknown>).authorisationExpiresAt).toBeTruthy();
    // The inbox lists it for those who may offboard, until it's done.
    const inbox = (await cons('GET', '/inbox', { cookie: owner.cookie })).body.items as { type: string; tenant?: { id: string } }[];
    expect(inbox.some((x) => x.type === 'purge_waiting' && x.tenant?.id === t.id)).toBe(true);
    const support = (await cons('GET', '/inbox', { cookie: (await as('SUPPORT')).cookie })).body.items as { type: string }[];
    expect(support.some((x) => x.type === 'purge_waiting')).toBe(false);
  });

  it('a drill tenant is refused (Q-C8)', async () => {
    const drill = await institution('ARCHIVED', `shred-drill-${String(randomInt(10_000_000, 99_999_999))}`);
    try {
      expect((await ask((await as('OWNER')).cookie, drill)).body.code).toBe('tenant.not_purgeable');
      expect(await refusedWith(check(migrator, drill.slug))).toBe('drill_tenant');
    } finally {
      await migrator.tenantDomain.deleteMany({ where: { tenantId: drill.id } });
      await migrator.tenantProduct.deleteMany({ where: { tenantId: drill.id } });
      await migrator.tenantBranding.deleteMany({ where: { tenantId: drill.id } });
      await migrator.tenantDataKey.deleteMany({ where: { tenantId: drill.id } });
      await migrator.platformApproval.deleteMany({ where: { kind: 'tenant.purge', payload: { path: ['tenantId'], equals: drill.id } } });
      // Its tenant rows are removed by the prefix-less cleanup below; the tenant row last.
      for (const table of PURGE_TABLE_ORDER) {
        await shard.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${drill.id}, true)`;
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1::uuid`, drill.id);
        });
      }
      await migrator.tenant.delete({ where: { id: drill.id } });
    }
  });
});

describe('[Q10, Q-C3, A12] the job, step by step', () => {
  it('needs an authorisation, uses it once, and runs keys, rows, objects, platform and certificate in order', async () => {
    const t = await institution();
    const other = await institution();
    const otherBefore = await tenantRows(other.id);
    expect(await refusedWith(check(migrator, t.slug))).toBe('no_authorisation');
    const approvalId = await authorised(t);
    // Q11, A7: with a second person here, solo is refused; and a solo run needs a reason.
    expect(await refusedWith(check(migrator, t.slug, { solo: true, reason: 'Nobody else is here to approve it' }))).toBe('solo_and_authorised');
    expect(await refusedWith(check(migrator, t.slug, { solo: true }))).toBe('reason');

    const run = await begin(migrator, t.slug);
    expect(run).toMatchObject({ approvalId, solo: false });
    // Idempotent: beginning again returns the same purge, and the authorisation is now used.
    expect((await begin(migrator, t.slug)).id).toBe(run.id);
    expect((await check(migrator, t.slug)).resuming).toBe(true);

    // The rows can't go before the keys, and the keys step needs the keys destroyed.
    expect(await refusedWith(rows(migrator, shard, t.slug))).toBe('step_out_of_order');
    expect(await refusedWith(keysDone(migrator, t.slug, randomUUID()))).toBe('keys_not_destroyed');
    // Q-C9: once begun, the console can't extend it.
    await migrator.platformTenantOffboarding.create({ data: { tenantId: t.id, reason: 'CONTRACT_ENDED', previousStatus: 'ACTIVE', startedBy: (await as('OWNER')).id, startedAt: new Date(Date.now() - 61 * DAY), firstEndsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() - DAY), archivedAt: new Date() } });
    expect((await cons('POST', `/tenants/${t.id}/offboarding/extend`, { cookie: (await as('OWNER')).cookie, body: { reason: 'They missed their export' } })).body.code).toBe('tenant.purge_started');

    await destroyKeys(t.id);
    const op = randomUUID();
    await keysDone(migrator, t.slug, op);
    await keysDone(migrator, t.slug, randomUUID()); // done: a no-op, the first op kept
    expect((await migrator.platformTenantPurge.findUniqueOrThrow({ where: { tenantId: t.id } })).keysOp).toBe(op);

    const before = await tenantRows(t.id);
    expect(before.audit_event).toBe(1);
    expect(before.org_unit).toBe(3);
    expect((await rows(migrator, shard, t.slug)).rows).toEqual(before);
    expect(Object.values(await tenantRows(t.id)).every((n) => n === 0)).toBe(true);
    // Another institution is untouched.
    expect(await tenantRows(other.id)).toEqual(otherBefore);

    const objectsRun = await objects(migrator, storage, t.slug);
    expect(objectsRun.objects).toEqual({ 'uv-quarantine': 2, 'uv-clean': 2, 'uv-exports': 2 });
    for (const b of storage.buckets) {
      expect(await keysIn(b, t.id)).toBe(0);
      expect(await keysIn(b, other.id)).toBe(2);
    }

    const plat = await platformRows(migrator, t.slug);
    expect(Object.keys(plat.platformRows as object).sort()).toEqual([...PURGED_PLATFORM_TABLES].sort());
    expect(plat.platformRows).toMatchObject({ tenant_domain: 1, tenant_product: 1, tenant_branding: 1 });
    const tomb = await migrator.tenant.findUniqueOrThrow({ where: { id: t.id } });
    expect(tomb).toMatchObject({ status: 'PURGED', slug: t.slug });
    expect(tomb.purgedAt).not.toBeNull();
    // Q13: the slug stays reserved for good.
    await expect(migrator.tenant.create({ data: { slug: t.slug, legalName: 'Someone new', shortName: 'SN', type: 'UNIVERSITY', ownership: 'PRIVATE', shardId: poolId } })).rejects.toThrow();
    // What stays: its keys' records, its offboarding record.
    expect(await migrator.tenantDataKey.count({ where: { tenantId: t.id } })).toBeGreaterThan(0);
    expect(await migrator.platformTenantOffboarding.count({ where: { tenantId: t.id } })).toBe(1);

    const f = await facts(migrator, t.slug);
    expect(f).toMatchObject({ institution: { slug: t.slug, status: 'PURGED' }, authority: { solo: false, approvalId, askedBy: 'Test OWNER', approvedBy: 'Test SUPER_ADMIN' }, keys: { op } });
    const text = `${JSON.stringify({ ...f, lastBackupExpiresBy: '2026-12-31' }, null, 2)}\n`;
    const sha = createHash('sha256').update(text).digest('hex');
    expect(await refusedWith(finish(migrator, t.slug, text, '0'.repeat(64)))).toBe('certificate_hash');
    await finish(migrator, t.slug, text, sha);
    expect((await migrator.tenant.findUniqueOrThrow({ where: { id: t.id } })).purgeCertificateSha256).toBe(sha);
    expect(await migrator.platformAuditEvent.findFirst({ where: { tenantId: t.id, action: 'platform.tenant.purged' } })).not.toBeNull();
    // Each step's own audit event, in order.
    const steps = (await migrator.platformAuditEvent.findMany({ where: { tenantId: t.id, action: 'platform.tenant.purge_step' }, orderBy: { seq: 'asc' } })).map((e) => (e.metadata as { step: string }).step);
    expect(steps).toEqual(['keys', 'rows', 'objects', 'platform']);
    // Done: every step a no-op now; the page shows the certificate; the inbox has let it go.
    await rows(migrator, shard, t.slug);
    await platformRows(migrator, t.slug);
    const page = (await cons('GET', `/tenants/${t.id}`, { cookie: (await as('OWNER')).cookie })).body.purge as { run: Record<string, unknown> };
    expect(page.run).toMatchObject({ solo: false, certificateSha256: sha });
    const inbox = (await cons('GET', '/inbox', { cookie: (await as('OWNER')).cookie })).body.items as { type: string; tenant?: { id: string } }[];
    expect(inbox.some((x) => x.type === 'purge_waiting' && x.tenant?.id === t.id)).toBe(false);
    // A second purge of it, or a reused authorisation, is refused.
    expect(await refusedWith(begin(migrator, other.slug))).toBe('no_authorisation');
  });

  it('an authorisation expires after 7 days, and is used once', async () => {
    const t = await institution();
    await authorised(t);
    expect(await refusedWith(check(migrator, t.slug, {}, new Date(Date.now() + 7 * DAY + 60_000)))).toBe('authorisation_expired');
    expect(await refusedWith(check(migrator, t.slug, {}, new Date(Date.now() + 7 * DAY - 60_000)))).toBeNull();
  });

  it('an institution given more time after its authorisation is refused by the host (Q-C9)', async () => {
    const t = await institution();
    await authorised(t);
    // The extension, as the console does it: back to OFFBOARDING for 14 days.
    await migrator.tenant.update({ where: { id: t.id }, data: { status: 'OFFBOARDING' } });
    expect(await refusedWith(check(migrator, t.slug))).toBe('not_archived');
    expect(await refusedWith(begin(migrator, t.slug))).toBe('not_archived');
    expect(await migrator.platformTenantPurge.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('an authorisation recorded as used by another purge is refused, whatever the records say', async () => {
    const t = await institution();
    const approvalId = await authorised(t);
    // A tampered or mistaken record: another institution's purge naming this approval.
    const other = await institution();
    await migrator.platformTenantPurge.create({ data: { tenantId: other.id, approvalId, solo: false } });
    expect(await refusedWith(check(migrator, t.slug))).toBe('authorisation_used');
  });

  it('the database keeps the order and the record: no step before the one ahead of it, none changed once done', async () => {
    const t = await institution();
    await authorised(t);
    const run = await begin(migrator, t.slug);
    await expect(migrator.platformTenantPurge.update({ where: { id: run.id }, data: { rows: {}, rowsDeletedAt: new Date() } })).rejects.toThrow();
    await destroyKeys(t.id);
    await keysDone(migrator, t.slug, randomUUID());
    await expect(migrator.platformTenantPurge.update({ where: { id: run.id }, data: { keysOp: randomUUID() } })).rejects.toThrow(/recorded once/);
    await expect(migrator.platformTenantPurge.update({ where: { id: run.id }, data: { solo: true } })).rejects.toThrow();
    // A solo purge with no reason, or with an approval too, can't be stored.
    await expect(migrator.platformTenantPurge.create({ data: { tenantId: (await institution()).id, solo: true } })).rejects.toThrow();
    // The console's role reads the purge, and can't write it.
    await expect(consoleDb.platformTenantPurge.update({ where: { id: run.id }, data: { updatedAt: new Date() } })).rejects.toThrow();
  });
});
