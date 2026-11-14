/**
 * Spec 0037 Q10, Q11 (E12, ADR-035): a notice's email to each institution's IT Admins and the delivery log, against
 * the real databases, as the worker runs them. One email per IT Admin goes into that institution's outbox, named by the
 * notice; running again adds none; a suspended institution's outbox sends the notice and holds everything else; the
 * counts reach the platform and nothing else does: no address, name or user id. Institutions here are their own
 * (slug `ntc-fo-…`), published to by hand as the migrator, removed at the end.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../config/config.js';
import type { OutboundEmail } from '../../shared/infra/mailer.js';
import { OutboxWorker } from '../../shared/outbox/outbox-worker.js';
import { Outbox } from '../../shared/outbox/outbox.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { NoticeFanOut, noticeEmail } from './notice-fan-out.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'ntc-fo-';
const sent: OutboundEmail[] = [];
let worker: INestApplicationContext;
let migrator: PlatformClient;
let shard: TenantShardClient;
let fanOut: NoticeFanOut;
let poolId: string;
let authorId: string;
let config: AppConfig;
const notices: string[] = [];

/** An institution with two IT Admins (one without an address), a revoked one, and a student. */
async function institution(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const t = await migrator.tenant.create({ data: { slug, legalName: `Fan Out Polytechnic ${slug}`, shortName: 'FOP', type: 'POLYTECHNIC', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  // Its own data key: its outbox encrypts every email under it.
  await provisionTenantKey(migrator, keyProviderFrom(config), t.id);
  const db = forTenant(shard, t.id);
  const admin = await db.role.create({ data: { tenantId: t.id, key: 'INSTITUTION_ADMIN', name: 'IT Admin', isSystem: true, permissions: ['settings.product.manage'] }, select: { id: true } });
  const student = await db.role.create({ data: { tenantId: t.id, key: 'STUDENT', name: 'Student', isSystem: true, permissions: [] }, select: { id: true } });
  const person = async (roleId: string, email: string | null, revoked = false) => {
    const username = `FO-${randomBytes(3).toString('hex').toUpperCase()}`;
    const u = await db.userAccount.create({ data: { tenantId: t.id, username, displayName: 'Test Person', status: 'ACTIVE', email }, select: { id: true } });
    await db.roleAssignment.create({ data: { tenantId: t.id, userId: u.id, roleId, scopeType: 'INSTITUTION', ...(revoked ? { revokedAt: new Date() } : {}) } });
    return email;
  };
  const addresses = [await person(admin.id, `it-${slug}@test.local`), await person(admin.id, `it2-${slug}@test.local`)];
  await person(admin.id, null);
  await person(admin.id, `gone-${slug}@test.local`, true);
  await person(student.id, `student-${slug}@test.local`);
  return { id: t.id, addresses };
}

/** A published notice to these institutions, as the console would leave it. */
async function publish(tenantIds: string[], over: { title?: string; body?: string } = {}) {
  const now = new Date();
  const n = await migrator.platformNotice.create({
    data: { kind: 'ANNOUNCEMENT', title: over.title ?? 'New results screens', body: over.body ?? 'From Monday.', audience: 'TENANTS', tenantIds, createdBy: authorId },
    select: { id: true },
  });
  await migrator.platformNotice.update({ where: { id: n.id }, data: { status: 'PUBLISHED', publishedAt: now, publishedBy: authorId, shownUntil: new Date(now.getTime() + 86_400_000) } });
  await migrator.platformNoticeDelivery.createMany({ data: tenantIds.map((tenantId) => ({ noticeId: n.id, tenantId })) });
  notices.push(n.id);
  return n.id;
}

const delivery = (noticeId: string, tenantId: string) => migrator.platformNoticeDelivery.findUniqueOrThrow({ where: { noticeId_tenantId: { noticeId, tenantId } } });
const deliver = (tenantId: string, noticesOnly = false) => worker.get(OutboxWorker).runTenant({ id: tenantId, shardId: poolId, noticesOnly });

beforeAll(async () => {
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  authorId = (await migrator.platformUser.create({ data: { email: `fanout-${randomBytes(4).toString('hex')}@staff.test`, displayName: 'Fan-out test', role: 'READ_ONLY', isActive: false }, select: { id: true } })).id;
  config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', NOTICE_RELAY_INTERVAL_MS: '0', NOTICE_COUNT_INTERVAL_MS: '0' }, 'worker');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, { mailer: { send: (m) => (sent.push(m), Promise.resolve()) }, subscribe: false }), { logger: false });
  fanOut = worker.get(NoticeFanOut);
});

afterAll(async () => {
  await migrator.platformNoticeDelivery.deleteMany({ where: { noticeId: { in: notices } } });
  await migrator.platformNotice.deleteMany({ where: { id: { in: notices } } });
  await migrator.platformUser.deleteMany({ where: { id: authorId } });
  await shard.$disconnect();
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await worker.close();
});

describe('[Q10] the fan-out', () => {
  it('writes one email per IT Admin with an address into the institution’s outbox, once', async () => {
    const a = await institution();
    const markup = '<script>alert(1)</script> See https://example.test';
    const id = await publish([a.id], { body: markup });
    expect(await fanOut.fanOut(id, a.id)).toEqual({ itAdmins: 2, queued: 2 });
    expect(await fanOut.fanOut(id, a.id)).toBeNull();
    const events = await forTenant(shard, a.id).outboxEvent.findMany({ where: { noticeId: id }, select: { status: true } });
    expect(events).toHaveLength(2);
    expect(await delivery(id, a.id)).toMatchObject({ itAdmins: 2, emailsQueued: 2, emailsSent: 0 });

    sent.length = 0;
    await deliver(a.id);
    expect(sent.map((m) => m.to).sort()).toEqual([...a.addresses].sort());
    const mail = sent[0]!;
    expect(mail.subject).toBe('UniVarse: New results screens');
    // Plain text, exactly as written.
    expect(mail.text).toContain(markup);
    expect(mail.text).toContain('IT Admin for Fan Out Polytechnic');
  });

  it('runs again after a crash between the two sides without emailing twice', async () => {
    const a = await institution();
    const id = await publish([a.id]);
    await fanOut.fanOut(id, a.id);
    // As if the platform side never heard: the emails are there, the delivery says nothing went out.
    await migrator.$executeRaw`ALTER TABLE platform_notice_delivery DISABLE TRIGGER platform_notice_delivery_guard_update`;
    try {
      await migrator.platformNoticeDelivery.update({ where: { noticeId_tenantId: { noticeId: id, tenantId: a.id } }, data: { fannedOutAt: null, itAdmins: null, emailsQueued: null } });
    } finally {
      await migrator.$executeRaw`ALTER TABLE platform_notice_delivery ENABLE TRIGGER platform_notice_delivery_guard_update`;
    }
    expect(await fanOut.fanOut(id, a.id)).toEqual({ itAdmins: 2, queued: 2 });
    expect(await forTenant(shard, a.id).outboxEvent.count({ where: { noticeId: id } })).toBe(2);
  });

  it('emails nobody about a notice withdrawn before it went out, and records that', async () => {
    const a = await institution();
    const id = await publish([a.id]);
    await migrator.platformNoticeDelivery.updateMany({ where: { noticeId: id }, data: { withdrawnAt: new Date() } });
    expect(await fanOut.fanOut(id, a.id)).toEqual({ itAdmins: 0, queued: 0 });
    expect(await forTenant(shard, a.id).outboxEvent.count({ where: { noticeId: id } })).toBe(0);
  });

  it('a suspended institution’s outbox sends the notice and holds everything else (Q8)', async () => {
    const s = await institution('SUSPENDED');
    const id = await publish([s.id]);
    await fanOut.fanOut(id, s.id);
    await worker.get(ShardRegistry).tx(poolId, s.id, (tx) => worker.get(Outbox).enqueueEmail(tx, s.id, { to: `held-${s.id}@test.local`, subject: 'Held', text: 'Held' }));
    sent.length = 0;
    await deliver(s.id, true);
    expect(sent.map((m) => m.subject)).toEqual(['UniVarse: New results screens', 'UniVarse: New results screens']);
    const held = await forTenant(shard, s.id).outboxEvent.findMany({ where: { noticeId: null }, select: { status: true } });
    expect(held).toEqual([{ status: 'PENDING' }]);
  });
});

describe('[Q11] the delivery log', () => {
  it('counts sent, failed and dismissed from the institution, and the platform holds nothing else', async () => {
    const a = await institution();
    const id = await publish([a.id]);
    await fanOut.fanOut(id, a.id);
    const db = forTenant(shard, a.id);
    const [first] = await db.outboxEvent.findMany({ where: { noticeId: id }, select: { id: true } });
    await db.outboxEvent.update({ where: { id: first!.id }, data: { status: 'DEAD', attempts: 8 } });
    await deliver(a.id);
    const student = await db.userAccount.findFirstOrThrow({ where: { roleAssignments: { some: { role: { key: 'STUDENT' } } } }, select: { id: true } });
    await db.noticeDismissal.create({ data: { tenantId: a.id, userId: student.id, noticeId: id } });
    await fanOut.count(id, a.id, poolId);
    expect(await delivery(id, a.id)).toMatchObject({ itAdmins: 2, emailsQueued: 2, emailsSent: 1, emailsFailed: 1, bannersDismissed: 1 });
    // Lopsided, so a sent email can't pass for a failed one: both refused now.
    await db.outboxEvent.updateMany({ where: { noticeId: id }, data: { status: 'DEAD' } });
    await fanOut.count(id, a.id, poolId);
    expect(await delivery(id, a.id)).toMatchObject({ emailsSent: 0, emailsFailed: 2 });

    // ADR-035: every column the delivery log has is an id, a count or a time. No address, name or text.
    const cols = await migrator.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'platform_notice_delivery' ORDER BY column_name`;
    expect(cols.filter((c) => !['uuid', 'integer', 'timestamp with time zone'].includes(c.data_type))).toEqual([]);
  });

  it('a recount doesn’t empty the institutions’ caches; a withdrawal does (the capture fires on that alone)', async () => {
    const a = await institution();
    const id = await publish([a.id]);
    await fanOut.fanOut(id, a.id);
    const events = async () => Number((await migrator.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM cache_invalidation_event WHERE tenant_id = ${a.id}::uuid AND source LIKE 'platform_notice_delivery:%'`)[0]?.n ?? 0);
    const before = await events();
    await fanOut.count(id, a.id, poolId);
    expect(await events()).toBe(before);
    await migrator.platformNoticeDelivery.updateMany({ where: { noticeId: id }, data: { withdrawnAt: new Date() } });
    expect(await events()).toBe(before + 1);
  });

  it('the email is one line of subject, whatever the title holds', () => {
    expect(noticeEmail({ kind: 'MAINTENANCE', title: 'Line one\r\nBcc: x@example.test', body: 'b', startsAt: new Date('2026-11-18T21:00:00Z'), endsAt: new Date('2026-11-18T23:00:00Z') }, 'X').subject).toBe('UniVarse: Line one Bcc: x@example.test');
  });
});
