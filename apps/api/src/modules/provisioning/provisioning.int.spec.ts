/**
 * Spec 0034: provisioning end to end against the real databases, Vault (the tenant KEK) and Valkey: the console's
 * routes through the platform API's own HTTP stack as the console role, and the worker's steps as the worker runs them.
 * The databases are shared, so every institution here has a slug of its own, and at the end each is archived and its
 * host released (its tenant-side rows stay: the tenant audit chain is append-only).
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LocalKeyProvider, sealInvite } from '@univarse/crypto';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { hashPassword } from '../identity/password.js';
import { PlatformSessions } from '../../platform/identity/sessions.js';
import { createPlatformApp } from '../../platform/platform-app.js';
import { CONSOLE_DB } from '../../platform/platform-config.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { OnboardingCheck } from './onboarding-check.js';
import { PROVISIONING_QUEUE, ProvisioningQueue, QUEUE_PREFIX } from './provisioning-queue.js';
import { ProvisioningRunner } from './provisioning-runner.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PASSWORD = 'Correct-Horse-Battery-9';
const HOST = 'console.univarse.localhost';
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

/** One key for both halves here; the stack splits it in Vault (PR C), tested there. */
const INVITE_KEY = new LocalKeyProvider('provisioning', randomBytes(32).toString('base64'));

let app: NestFastifyApplication;
let worker: INestApplicationContext;
let db: PlatformClient;
let migrator: PlatformClient;
let runner: ProvisioningRunner;
let shards: ShardRegistry;
const staffIds = new Set<string>();
const tenantIds = new Set<string>();
const sessions = new Map<Role, string>();

interface Res {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}

async function call(method: 'GET' | 'PUT' | 'POST', url: string, opts: { cookie?: string; body?: unknown; key?: string | null } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/platform/v1${url}`,
      remoteAddress: `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* 204 */
  }
  return { status: res.statusCode, body, headers: res.headers };
}

async function session(role: Role, stepUp = true): Promise<string> {
  const email = `prov-${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  const { id } = await db.platformUser.create({ data: { email, displayName: `Prov ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  staffIds.add(id);
  const now = new Date();
  const { token } = await db.$transaction((tx) => app.get(PlatformSessions).create(tx, id, { ip: '127.0.0.1', userAgent: 'test' }, { mfaAt: now, restricted: false, stepUpAt: stepUp ? now : null }));
  return `__Host-uv_console_sid=${token}`;
}
const as = async (role: Role) => {
  let s = sessions.get(role);
  if (!s) sessions.set(role, (s = await session(role)));
  return s;
};

const ADMIN_EMAIL = (tag: string) => `itadmin-${tag}@inst.test`;
function request(over: Record<string, unknown> = {}) {
  const tag = randomBytes(4).toString('hex');
  return {
    tag,
    body: {
      slug: `prov-${tag}`,
      legalName: `Provisioning Test Polytechnic ${tag}`,
      shortName: `PTP${tag}`.toUpperCase(),
      type: 'POLYTECHNIC',
      ownership: 'STATE',
      template: 'polytechnic',
      state: 'Ogun',
      products: ['academics'],
      admin: { displayName: 'Ngozi Adeyemi', email: ADMIN_EMAIL(tag), username: 'itadmin' },
      ...over,
    },
  };
}

async function create(over: Record<string, unknown> = {}) {
  const r = request(over);
  const res = await call('POST', '/tenants', { cookie: await as('OWNER'), body: r.body, key: randomUUID() });
  expect(res.status).toBe(202);
  const tenantId = res.body.tenantId as string;
  tenantIds.add(tenantId);
  return { ...r, tenantId, jobId: res.body.jobId as string };
}

/** Everything about one tenant, platform and tenant side, as a digest: equal before and after means untouched. */
async function digest(tenantId: string): Promise<string> {
  const t = await migrator.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { domains: true, products: true, dataKeys: true, branding: true, regulatoryProfile: true, dpa: true, onboarding: true },
  });
  const tenantSide = await shards.tx(t.shardId, tenantId, async (tx) => ({
    users: await tx.userAccount.findMany({ orderBy: { id: 'asc' } }),
    roles: await tx.role.findMany({ orderBy: { id: 'asc' } }),
    assignments: await tx.roleAssignment.findMany({ orderBy: { id: 'asc' } }),
    settings: await tx.setting.findMany({ orderBy: { id: 'asc' } }),
    units: await tx.orgUnit.findMany({ orderBy: { id: 'asc' } }),
    outbox: await tx.outboxEvent.count(),
  }));
  return createHash('sha256')
    .update(JSON.stringify({ t, tenantSide }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))
    .digest('hex');
}

async function counts(tenantId: string) {
  const t = await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { shardId: true } });
  const side = await shards.tx(t.shardId, tenantId, async (tx) => ({
    users: await tx.userAccount.count(),
    roles: await tx.role.count(),
    assignments: await tx.roleAssignment.count(),
    settings: await tx.setting.count(),
    units: await tx.orgUnit.count(),
    emails: await tx.outboxEvent.count({ where: { type: 'email.send' } }),
  }));
  return {
    ...side,
    keys: await migrator.tenantDataKey.count({ where: { tenantId } }),
    hosts: await migrator.tenantDomain.count({ where: { tenantId } }),
    products: await migrator.tenantProduct.count({ where: { tenantId } }),
  };
}

const actions = async (tenantId: string) => (await migrator.platformAuditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' }, select: { action: true } })).map((a) => a.action);

async function workerContext(provisioningKeys: LocalKeyProvider) {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', PROVISIONING_RELAY_INTERVAL_MS: '0', ONBOARDING_CHECK_INTERVAL_MS: '0' }, 'worker');
  return NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, { mailer: { send: () => Promise.resolve() }, subscribe: false, provisioningKeys, provisioningRetryDelays: [] }),
    { logger: false },
  );
}

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { provisioningKeys: INVITE_KEY });
  db = app.get(CONSOLE_DB);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  worker = await workerContext(INVITE_KEY);
  runner = worker.get(ProvisioningRunner);
  shards = worker.get(ShardRegistry);
});

afterAll(async () => {
  await db.platformSession.updateMany({ where: { userId: { in: [...staffIds] }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await db.platformUser.updateMany({ where: { id: { in: [...staffIds] } }, data: { role: 'READ_ONLY', isActive: false } });
  // Every institution these tests made, both sides of it (each has a slug starting `prov-`).
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, 'prov-');
  await worker.close();
  await app.close();
});

describe('[Q1, Q12] who may create, and how', () => {
  it('only OWNER and SUPER_ADMIN, stepped up, with an Idempotency-Key; to anyone else the route is absent', async () => {
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
      expect([role, (await call('POST', '/tenants', { cookie: await as(role), body: request().body, key: randomUUID() })).status]).toEqual([role, 404]);
    }
    const cold = await session('SUPER_ADMIN', false);
    expect((await call('POST', '/tenants', { cookie: cold, body: request().body, key: randomUUID() })).body.code).toBe('auth.step_up_required');
    const noKey = await call('POST', '/tenants', { cookie: await as('OWNER'), body: request().body });
    expect([noKey.status, noKey.body.code]).toEqual([400, 'request.invalid']);
    const created = await call('POST', '/tenants', { cookie: await as('SUPER_ADMIN'), body: request().body, key: randomUUID() });
    expect(created.status).toBe(202);
    tenantIds.add(created.body.tenantId as string);
  });

  it('a repeated key returns the first answer and makes nothing more', async () => {
    const key = randomUUID();
    const cookie = await as('OWNER');
    const first = await call('POST', '/tenants', { cookie, body: request().body, key });
    tenantIds.add(first.body.tenantId as string);
    const again = await call('POST', '/tenants', { cookie, body: request().body, key });
    expect([again.status, again.body, again.headers['idempotent-replayed']]).toEqual([202, first.body, 'true']);
    // Another member's same key is their own request.
    const other = await call('POST', '/tenants', { cookie: await as('SUPER_ADMIN'), body: request().body, key });
    tenantIds.add(other.body.tenantId as string);
    expect(other.body.tenantId).not.toBe(first.body.tenantId);
  });

  it('[Q5] a malformed, reserved or used slug is refused with its own code', async () => {
    const cookie = await as('OWNER');
    const post = (slug: string) => call('POST', '/tenants', { cookie, body: request({ slug }).body, key: randomUUID() });
    expect((await post('Bad_Slug')).body.code).toBe('tenant.slug_invalid');
    expect((await post('console')).body.code).toBe('tenant.slug_reserved');
    const taken = await post('demo-uni');
    expect([taken.status, taken.body.code]).toEqual([409, 'tenant.slug_taken']);
    expect((await call('POST', '/tenants', { cookie, body: request({ products: ['teleportation'] }).body, key: randomUUID() })).body.code).toBe('tenant.product_unknown');
  });

  it('[Q7] without the provisioning key, creating is unavailable and nothing is written', async () => {
    const off = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { provisioningKeys: null });
    try {
      const r = request();
      const before = await migrator.tenant.count({ where: { slug: r.body.slug } });
      const res = await off.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/platform/v1/tenants',
        remoteAddress: '127.0.0.9',
        headers: { host: HOST, 'sec-fetch-site': 'same-origin', cookie: await as('OWNER'), 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify(r.body),
      });
      expect([res.statusCode, (JSON.parse(res.body) as { code: string }).code]).toEqual([503, 'provisioning.unavailable']);
      expect(await migrator.tenant.count({ where: { slug: r.body.slug } })).toBe(before);
      // A request already made is still answered: a replay needs no key.
      const key = randomUUID();
      const first = await call('POST', '/tenants', { cookie: await as('OWNER'), body: request().body, key });
      tenantIds.add(first.body.tenantId as string);
      const replay = await off.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/platform/v1/tenants',
        remoteAddress: '127.0.0.9',
        headers: { host: HOST, 'sec-fetch-site': 'same-origin', cookie: await as('OWNER'), 'idempotency-key': key, 'content-type': 'application/json' },
        payload: JSON.stringify(request().body),
      });
      expect([replay.statusCode, JSON.parse(replay.body)]).toEqual([202, first.body]);
    } finally {
      await off.close();
    }
  });
});

describe('[Q5, Q7] a request, then the eight steps', () => {
  it('records the tenant, the job and the audit together; the invite is sealed and the console can never read it', async () => {
    const { tenantId, jobId, tag, body } = await create();
    const t = await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true, template: true, slug: true } });
    expect(t).toEqual({ status: 'REQUESTED', template: 'polytechnic@1', slug: body.slug });
    const job = await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId } });
    expect([job.status, job.products, job.inviteMasked]).toEqual(['QUEUED', ['academics', 'core'], `i•••@inst.test`]);
    expect(JSON.stringify(job)).not.toContain(ADMIN_EMAIL(tag));
    expect(JSON.stringify(job)).not.toContain('Ngozi');
    await expect(db.provisioningJob.findUnique({ where: { id: jobId }, select: { inviteEnc: true } })).rejects.toThrow();
    expect(await actions(tenantId)).toEqual(['platform.tenant.provisioning_requested']);
    const view = await call('GET', `/tenants/${tenantId}/provisioning`, { cookie: await as('READ_ONLY') });
    expect([view.status, view.body.status, (view.body.steps as { status: string }[]).every((s) => s.status === 'PENDING')]).toEqual([200, 'QUEUED', true]);
  });

  it('runs every step: ONBOARDING, reachable, keyed, seeded, templated, entitled, one administrator and one email, no demo accounts', async () => {
    const { tenantId, jobId, tag, body } = await create();
    expect(await runner.run(jobId)).toBe('done');
    const t = await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true, shardId: true } });
    expect(t.status).toBe('ONBOARDING');
    const c = await counts(tenantId);
    expect(c).toEqual({ users: 1, roles: 18, assignments: 1, settings: 1, units: 1, emails: 1, keys: 1, hosts: 1, products: 2 });
    const side = await shards.tx(t.shardId, tenantId, async (tx) => ({
      user: await tx.userAccount.findFirstOrThrow({ select: { username: true, email: true, status: true, passwordHash: true } }),
      role: await tx.roleAssignment.findFirstOrThrow({ select: { role: { select: { key: true } } } }),
      setting: await tx.setting.findFirstOrThrow({ select: { key: true, value: true } }),
    }));
    expect(side).toEqual({
      user: { username: 'ITADMIN', email: ADMIN_EMAIL(tag), status: 'PENDING_ACTIVATION', passwordHash: null },
      role: { role: { key: 'INSTITUTION_ADMIN' } },
      setting: { key: 'registration.unitLimits', value: { min: 15, max: 24 } },
    });
    expect((await migrator.tenantDomain.findFirstOrThrow({ where: { tenantId }, select: { hostname: true } })).hostname).toBe(`${body.slug}.univarse.localhost`);
    const job = await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId } });
    expect([job.status, job.inviteEnc, job.finishedAt !== null]).toEqual(['DONE', null, true]);
    const view = await call('GET', `/tenants/${tenantId}/provisioning`, { cookie: await as('READ_ONLY') });
    expect((view.body.steps as { status: string }[]).map((s) => s.status)).toEqual(Array(8).fill('DONE'));
    expect(await actions(tenantId)).toEqual([
      'platform.tenant.provisioning_requested',
      'platform.tenant.provisioning_started',
      'crypto.tenant_key.created',
      'platform.tenant.host_added',
      'platform.tenant.products_set',
      'platform.tenant.admin_invited',
      'platform.tenant.provisioned',
    ]);
    expect(await runner.run(jobId)).toBe('skipped');
  });

  it('[Q15] every step run again, as after a kill at any point, makes no duplicate role, key, host or email', async () => {
    const { tenantId, jobId } = await create();
    expect(await runner.run(jobId)).toBe('done');
    const t = await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { shardId: true } });
    // The institution changed its setting since: a re-run must leave it as they set it.
    await shards.tx(t.shardId, tenantId, (tx) => tx.setting.updateMany({ where: { key: 'registration.unitLimits' }, data: { value: { min: 12, max: 20 } } }));
    const before = await counts(tenantId);
    // As if the worker died with every step half done: the steps' rows say RUNNING, the tenant is mid-way, and the
    // invite step died after the account and its email committed but before the invite was wiped.
    await migrator.provisioningStep.updateMany({ where: { jobId }, data: { status: 'RUNNING', finishedAt: null } });
    const job = await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { tenantId: true } });
    const sealed = await sealInvite(INVITE_KEY, job.tenantId, { displayName: 'Ngozi Adeyemi', email: (await shards.tx(t.shardId, tenantId, (tx) => tx.userAccount.findFirstOrThrow({ select: { email: true } }))).email ?? '', username: 'ITADMIN' });
    await migrator.tenant.update({ where: { id: tenantId }, data: { status: 'PROVISIONING' } });
    await migrator.provisioningJob.update({ where: { id: jobId }, data: { status: 'RUNNING', finishedAt: null, inviteEnc: sealed } });
    expect(await runner.run(jobId)).toBe('done');
    expect(await counts(tenantId)).toEqual(before);
    expect((await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { inviteEnc: true } })).inviteEnc).toBeNull();
    expect(await shards.tx(t.shardId, tenantId, (tx) => tx.setting.findFirstOrThrow({ where: { key: 'registration.unitLimits' }, select: { value: true } }))).toEqual({ value: { min: 12, max: 20 } });
    expect((await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } })).status).toBe('ONBOARDING');
    expect(await migrator.provisioningStep.findMany({ where: { jobId }, select: { attempts: true } })).toEqual(Array(8).fill({ attempts: 2 }));
  });

  it('[Q8] a failure stops at its step with a fixed code; resume starts there and finishes', async () => {
    const { tenantId, jobId } = await create();
    const wrong = await workerContext(new LocalKeyProvider('wrong', randomBytes(32).toString('base64')));
    try {
      expect(await wrong.get(ProvisioningRunner).run(jobId)).toBe('failed');
    } finally {
      await wrong.close();
    }
    const failed = await call('GET', `/tenants/${tenantId}/provisioning`, { cookie: await as('READ_ONLY') });
    expect([failed.body.status, failed.body.error]).toEqual(['FAILED', { step: 'invite', code: 'invite_unreadable' }]);
    expect((failed.body.steps as { step: string; status: string }[]).map((s) => s.status)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'FAILED', 'PENDING']);
    expect(await runner.run(jobId)).toBe('skipped'); // a failed job waits for the console
    expect((await call('POST', `/tenants/${tenantId}/provisioning/resume`, { cookie: await as('SUPPORT') })).status).toBe(404);
    expect((await call('POST', `/tenants/${tenantId}/provisioning/resume`, { cookie: await as('OWNER') })).status).toBe(204);
    expect((await call('POST', `/tenants/${tenantId}/provisioning/resume`, { cookie: await as('OWNER') })).body.code).toBe('provisioning.not_failed');
    expect(await runner.run(jobId)).toBe('done');
    const c = await counts(tenantId);
    expect([c.users, c.emails, c.keys, c.hosts]).toEqual([1, 1, 1, 1]);
    const a = await actions(tenantId);
    expect(a).toContain('platform.tenant.provisioning_failed');
    expect(a).toContain('platform.tenant.provisioning_resumed');
    expect(a.at(-1)).toBe('platform.tenant.provisioned');
  });

  it('[Q14] provisioning B leaves every row of A unchanged, and the platform rows of every other tenant', async () => {
    const demo = await migrator.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' }, select: { id: true } });
    const poly = await migrator.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' }, select: { id: true } });
    const before = [await digest(demo.id), await digest(poly.id)];
    const { jobId } = await create();
    expect(await runner.run(jobId)).toBe('done');
    expect([await digest(demo.id), await digest(poly.id)]).toEqual(before);
  });

  it('[Q5] a step refuses a tenant that isn’t in the status it expects, and changes nothing', async () => {
    const { tenantId, jobId } = await create();
    await migrator.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    expect(await runner.run(jobId)).toBe('failed');
    expect(await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { errorStep: true, errorCode: true } })).toEqual({ errorStep: 'place', errorCode: 'state_conflict' });
    expect(await counts(tenantId)).toMatchObject({ keys: 0, hosts: 0, products: 0, users: 0 });

    // Suspended mid-way, after "place": the next step refuses too, before writing anything.
    const mid = await create();
    await migrator.tenant.update({ where: { id: mid.tenantId }, data: { status: 'SUSPENDED' } });
    await migrator.provisioningStep.create({ data: { jobId: mid.jobId, step: 'place', status: 'DONE', finishedAt: new Date() } });
    expect(await runner.run(mid.jobId)).toBe('failed');
    expect(await migrator.provisioningJob.findUniqueOrThrow({ where: { id: mid.jobId }, select: { errorStep: true, errorCode: true } })).toEqual({ errorStep: 'key', errorCode: 'state_conflict' });
    expect(await counts(mid.tenantId)).toMatchObject({ keys: 0 });
  });

  it('[Q5] a host already held by another institution stops the job with a conflict, and nothing of that host changes', async () => {
    const { tenantId, jobId, body } = await create();
    const other = await migrator.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' }, select: { id: true } });
    const host = await migrator.tenantDomain.create({ data: { tenantId: other.id, hostname: `${body.slug}.univarse.localhost`, kind: 'SUBDOMAIN' }, select: { id: true } });
    try {
      expect(await runner.run(jobId)).toBe('failed');
      expect((await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { errorStep: true, errorCode: true } }))).toEqual({ errorStep: 'host', errorCode: 'state_conflict' });
      expect(await migrator.tenantDomain.count({ where: { tenantId } })).toBe(0);
    } finally {
      await migrator.tenantDomain.delete({ where: { id: host.id } });
    }
  });
});

describe('[Q3] the queue', () => {
  it('a Valkey that lost the queue loses nothing: the relay queues the job again, and the consumer runs it', async () => {
    const { jobId, tenantId } = await create();
    const queue = worker.get(ProvisioningQueue);
    const conn = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
    const peek = new Queue(PROVISIONING_QUEUE, { connection: conn, prefix: QUEUE_PREFIX });
    try {
      expect(await queue.relay()).toBeGreaterThanOrEqual(1);
      expect((await peek.getJob(jobId))?.id).toBe(jobId);
      await peek.remove(jobId); // as if Valkey had been emptied
      expect(await peek.getJob(jobId)).toBeUndefined();
      await queue.relay();
      expect((await peek.getJob(jobId))?.id).toBe(jobId);
      queue.start();
      for (let i = 0; i < 60; i++) {
        const s = await migrator.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } });
        if (s.status === 'DONE') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect((await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } })).status).toBe('ONBOARDING');
    } finally {
      await queue.stop();
      await peek.close();
      conn.disconnect();
    }
  });
});

describe('[Q9, Q10] going live', () => {
  it('the checklist gates ONBOARDING → ACTIVE; the DPA is recorded by hand; each item is computed', async () => {
    const { tenantId, jobId } = await create({ products: [] });
    expect(await runner.run(jobId)).toBe('done');
    const owner = await as('OWNER');
    const look = async () => (await call('GET', `/tenants/${tenantId}/go-live`, { cookie: await as('READ_ONLY') })).body;
    const failing = async () => ((await look()).items as { item: string; passed: boolean }[]).filter((i) => !i.passed).map((i) => i.item);
    expect(await failing()).toEqual(['admin_ready', 'products', 'branding', 'regulatory', 'dpa']);
    const early = await call('POST', `/tenants/${tenantId}/go-live`, { cookie: owner });
    expect([early.status, early.body.code]).toEqual([409, 'tenant.go_live_incomplete']);

    // The DPA: never dated in the future; SUPPORT can't record one.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await call('PUT', `/tenants/${tenantId}/dpa`, { cookie: owner, body: { dpaVersion: 'v1', signedOn: tomorrow, reference: 'DPA-2026-001' } })).body.code).toBe('tenant.dpa_date');
    expect((await call('PUT', `/tenants/${tenantId}/dpa`, { cookie: await as('SUPPORT'), body: { dpaVersion: 'v1', signedOn: '2026-11-01', reference: 'DPA-2026-001' } })).status).toBe(404);
    expect((await call('PUT', `/tenants/${tenantId}/dpa`, { cookie: owner, body: { dpaVersion: 'v1', signedOn: '2026-11-01', reference: 'DPA-2026-001' } })).status).toBe(204);
    expect((await look()).dpa).toMatchObject({ dpaVersion: 'v1', signedOn: '2026-11-01', reference: 'DPA-2026-001', version: 1 });

    // The rest through the registry's own routes, as the console would.
    expect((await call('PUT', `/tenants/${tenantId}/products/bursary`, { cookie: owner, body: { entitled: true, reason: 'their first product' } })).status).toBe(204);
    expect((await call('PUT', `/tenants/${tenantId}/branding/color`, { cookie: owner, body: { primaryColor: '#0B3D91' } })).status).toBe(204);
    await migrator.tenantRegulatoryProfile.update({ where: { tenantId }, data: { operatingStatus: 'APPROVED' } });
    expect(await failing()).toEqual(['admin_ready']);

    // The administrator activates and sets up an authenticator; the worker's check records it, once.
    const t = await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { shardId: true } });
    const check = worker.get(OnboardingCheck);
    // Invited but not activated, then activated without an authenticator: not ready either time.
    expect(await check.checkTenant({ id: tenantId, shardId: t.shardId })).toBe(false);
    await shards.tx(t.shardId, tenantId, async (tx) => {
      const u = await tx.userAccount.findFirstOrThrow({ select: { id: true } });
      await tx.userAccount.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    });
    expect(await check.checkTenant({ id: tenantId, shardId: t.shardId })).toBe(false);
    await shards.tx(t.shardId, tenantId, async (tx) => {
      const u = await tx.userAccount.findFirstOrThrow({ select: { id: true } });
      await tx.mfaFactor.create({ data: { tenantId, userId: u.id, type: 'TOTP', secretEnc: 'v2:1:test:test:test', confirmedAt: new Date() } });
    });
    expect(await check.checkTenant({ id: tenantId, shardId: t.shardId })).toBe(true);
    expect(await check.checkTenant({ id: tenantId, shardId: t.shardId })).toBe(true);
    expect((await actions(tenantId)).filter((a) => a === 'platform.tenant.admin_ready')).toHaveLength(1);
    expect(await failing()).toEqual([]);
    expect((await look()).ready).toBe(true);

    expect((await call('POST', `/tenants/${tenantId}/go-live`, { cookie: await as('SUPPORT') })).status).toBe(404);
    expect((await call('POST', `/tenants/${tenantId}/go-live`, { cookie: owner })).status).toBe(204);
    expect((await migrator.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } })).status).toBe('ACTIVE');
    expect((await actions(tenantId)).at(-1)).toBe('platform.tenant.went_live');
    const again = await call('POST', `/tenants/${tenantId}/go-live`, { cookie: owner });
    expect([again.status, again.body.code]).toEqual([409, 'tenant.not_onboarding']);
  });

  it('an institution still provisioning, or unknown, can’t go live', async () => {
    const { tenantId } = await create();
    expect((await call('POST', `/tenants/${tenantId}/go-live`, { cookie: await as('OWNER') })).body.code).toBe('tenant.not_onboarding');
    expect((await call('POST', `/tenants/${randomUUID()}/go-live`, { cookie: await as('OWNER') })).status).toBe(404);
    expect((await call('GET', `/tenants/${randomUUID()}/provisioning`, { cookie: await as('OWNER') })).status).toBe(404);
  });
});
