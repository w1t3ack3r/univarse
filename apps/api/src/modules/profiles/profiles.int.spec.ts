/**
 * Spec 0041 (P2-S0): institution-type profiles against the real databases. The worker's `ProfilePass` assigns them to
 * institutions live without one (and completes the seed's requests); the snapshot is append-only, visible only inside
 * its own institution, never duplicated, and never changes the institution's own configuration. Institutions here are
 * their own (slug `prof-…`), removed at the end.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createPlatformClient, profileContentHash, seedTenantBase, type PlatformClient } from '@univarse/db';
import { canonicalJson, TEMPLATES, type TenantStatusName } from '@univarse/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { ProfilePass, templateOf } from './profile-pass.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'prof-';
const hashOf = (id: keyof typeof TEMPLATES) => profileContentHash(canonicalJson(TEMPLATES[id].profile));

let worker: INestApplicationContext;
let pass: ProfilePass;
let shards: ShardRegistry;
let migrator: PlatformClient;
let poolId: string;

type Type = 'UNIVERSITY' | 'POLYTECHNIC' | 'COLLEGE_OF_EDUCATION';

/** An institution of its own on the pool, with its org root and roles, in a status, from a template or none. */
async function institution(status: TenantStatusName, type: Type = 'POLYTECHNIC', template: string | null = null) {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const t = await migrator.tenant.create({
    data: { slug, legalName: `Profile Test ${slug}`, shortName: 'PT', type, ownership: 'STATE', status, shardId: poolId, template },
    select: { id: true, shardId: true },
  });
  await shards.tx(t.shardId, t.id, (tx) => seedTenantBase(tx, t.id, `Profile Test ${slug}`));
  return t;
}

const snapshots = (t: { id: string; shardId: string }) =>
  shards.tx(t.shardId, t.id, (tx) => tx.institutionProfile.findMany({ select: { tenantId: true, template: true, templateVersion: true, contentHash: true, source: true, profile: true } }));
const assignments = (tenantId: string) =>
  migrator.tenantProfileAssignment.findMany({ where: { tenantId }, select: { template: true, templateVersion: true, contentHash: true, source: true, status: true, errorCode: true, assignedAt: true } });
const audits = (t: { id: string; shardId: string }) =>
  shards.tx(t.shardId, t.id, (tx) => tx.auditEvent.findMany({ where: { action: 'setup.profile_assigned' }, select: { after: true } }));

beforeAll(async () => {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', PROFILE_PASS_INTERVAL_MS: '0' }, 'worker');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, { mailer: { send: () => Promise.resolve() }, subscribe: false, provisioningKeys: null }), { logger: false });
  pass = worker.get(ProfilePass);
  shards = worker.get(ShardRegistry);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
});

afterAll(async () => {
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await worker.close();
});

describe('[Q5, acceptance 3] the pass assigns institutions live without a profile', () => {
  it('ONBOARDING, ACTIVE and SUSPENDED get theirs: the snapshot, the audit and ASSIGNED, all with the same hash', async () => {
    const live = await Promise.all([institution('ONBOARDING'), institution('ACTIVE', 'UNIVERSITY'), institution('SUSPENDED', 'COLLEGE_OF_EDUCATION')]);
    const { assigned } = await pass.pass();
    expect(assigned).toBeGreaterThanOrEqual(3);
    for (const [t, id] of [
      [live[0], 'polytechnic'],
      [live[1], 'university'],
      [live[2], 'college-of-education'],
    ] as const) {
      const hash = hashOf(id);
      const [snap] = await snapshots(t);
      expect(snap).toMatchObject({ tenantId: t.id, template: id, templateVersion: 2, contentHash: hash, source: 'BACKFILL' });
      expect(snap?.profile).toEqual(JSON.parse(canonicalJson(TEMPLATES[id].profile)));
      const [a] = await assignments(t.id);
      expect(a).toMatchObject({ template: id, templateVersion: 2, contentHash: hash, source: 'BACKFILL', status: 'ASSIGNED', errorCode: null });
      expect(a?.assignedAt).toBeInstanceOf(Date);
      expect(await audits(t)).toEqual([{ after: { template: id, templateVersion: 2, sha256: hash, source: 'BACKFILL' } }]);
      const platformAudit = await migrator.platformAuditEvent.findMany({ where: { tenantId: t.id, action: 'platform.tenant.profile_assigned' }, select: { metadata: true } });
      expect(platformAudit).toEqual([{ metadata: { template: id, templateVersion: 2, sha256: hash, source: 'BACKFILL' } }]);
    }
  });

  it('OFFBOARDING, ARCHIVED, PURGED, REQUESTED and PROVISIONING ones get nothing, and nothing of theirs changes', async () => {
    const frozen = await Promise.all((['OFFBOARDING', 'ARCHIVED', 'PURGED', 'REQUESTED', 'PROVISIONING'] as const).map((s) => institution(s)));
    await pass.pass();
    for (const t of frozen) {
      expect(await assignments(t.id)).toEqual([]);
      expect(await snapshots(t)).toEqual([]);
      expect(await audits(t)).toEqual([]);
    }
  });

  it('an institution provisioned from a template keeps that template; one without takes its type’s', async () => {
    expect(templateOf({ template: 'college-of-education@1', type: 'POLYTECHNIC' }).id).toBe('college-of-education');
    expect(templateOf({ template: null, type: 'COLLEGE_OF_EDUCATION' }).id).toBe('college-of-education');
    expect(templateOf({ template: 'retired@1', type: 'UNIVERSITY' }).id).toBe('university');
    const t = await institution('ACTIVE', 'POLYTECHNIC', 'university@1');
    await pass.pass();
    expect((await assignments(t.id)).map((a) => [a.template, a.templateVersion, a.status])).toEqual([['university', 2, 'ASSIGNED']]);
  });

  it('the seed’s request (PENDING, SEED) is completed with its source kept', async () => {
    const t = await institution('ACTIVE');
    await migrator.tenantProfileAssignment.create({ data: { tenantId: t.id, template: 'polytechnic', templateVersion: 2, contentHash: hashOf('polytechnic'), source: 'SEED' } });
    await pass.pass();
    expect((await assignments(t.id)).map((a) => [a.source, a.status])).toEqual([['SEED', 'ASSIGNED']]);
    expect((await snapshots(t)).map((s) => s.source)).toEqual(['SEED']);
  });
});

describe('[Q5, Q11] assigning again changes nothing', () => {
  it('a second pass, and a pass stopped after the snapshot, write no second row, no second audit, and leave the institution’s configuration as it is', async () => {
    const t = await institution('ACTIVE');
    // The institution's own configuration, which no assignment may touch.
    await shards.tx(t.shardId, t.id, (tx) => tx.setting.create({ data: { tenantId: t.id, key: 'registration.unitLimits', scopeKey: 'INSTITUTION', value: { min: 12, max: 20 }, version: 3 } }));
    const config = () =>
      shards.tx(t.shardId, t.id, async (tx) => ({
        settings: await tx.setting.findMany({ orderBy: { id: 'asc' } }),
        roles: await tx.role.findMany({ orderBy: { id: 'asc' } }),
        units: await tx.orgUnit.findMany({ orderBy: { id: 'asc' } }),
      }));
    const before = await config();
    await pass.pass();
    const first = await assignments(t.id);
    await pass.pass();
    expect(await assignments(t.id)).toEqual(first);
    expect(await snapshots(t)).toHaveLength(1);
    expect(await audits(t)).toHaveLength(1);
    expect(await config()).toEqual(before);

    // As if the worker stopped after the snapshot committed but before ASSIGNED: the next pass only marks the row.
    const u = await institution('ACTIVE');
    await migrator.tenantProfileAssignment.create({ data: { tenantId: u.id, template: 'polytechnic', templateVersion: 2, contentHash: hashOf('polytechnic'), source: 'BACKFILL' } });
    await shards.tx(u.shardId, u.id, (tx) =>
      tx.institutionProfile.create({ data: { tenantId: u.id, template: 'polytechnic', templateVersion: 2, contentHash: hashOf('polytechnic'), profile: JSON.parse(canonicalJson(TEMPLATES.polytechnic.profile)) as object, source: 'BACKFILL' } }),
    );
    await pass.pass();
    expect((await assignments(u.id)).map((a) => a.status)).toEqual(['ASSIGNED']);
    expect(await snapshots(u)).toHaveLength(1);
    expect(await audits(u)).toEqual([]); // the snapshot wasn't this run's to audit
  });
});

describe('[Q6, Q8] a failure is recorded with its fixed code, and retried', () => {
  it('a row whose hash isn’t this version’s content is FAILED (hash_mismatch), never overwritten; once cleared, the next pass assigns', async () => {
    const t = await institution('ACTIVE');
    await migrator.tenantProfileAssignment.create({ data: { tenantId: t.id, template: 'polytechnic', templateVersion: 2, contentHash: '0'.repeat(64), source: 'BACKFILL' } });
    const r = await pass.pass();
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await assignments(t.id)).map((a) => [a.status, a.errorCode, a.contentHash])).toEqual([['FAILED', 'hash_mismatch', '0'.repeat(64)]]);
    expect(await snapshots(t)).toEqual([]);
    await migrator.tenantProfileAssignment.deleteMany({ where: { tenantId: t.id } });
    await pass.pass();
    expect((await assignments(t.id)).map((a) => [a.status, a.errorCode])).toEqual([['ASSIGNED', null]]);
  });
});

describe('[Q4, Q6, acceptance 4] the records can’t be rewritten', () => {
  it('the app can’t update or delete a snapshot; an ASSIGNED row and an assignment’s profile never change', async () => {
    const t = await institution('ACTIVE');
    await pass.pass();
    await expect(shards.tx(t.shardId, t.id, (tx) => tx.institutionProfile.updateMany({ data: { source: 'SEED' } }))).rejects.toThrow();
    await expect(shards.tx(t.shardId, t.id, (tx) => tx.institutionProfile.deleteMany({}))).rejects.toThrow();
    expect(await snapshots(t)).toHaveLength(1);
    // The worker's platform role is the app's.
    const platformApp = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
    try {
      await expect(platformApp.tenantProfileAssignment.updateMany({ where: { tenantId: t.id }, data: { status: 'PENDING', assignedAt: null } })).rejects.toThrow(/can.t change/);
      await expect(platformApp.tenantProfileAssignment.deleteMany({ where: { tenantId: t.id } })).rejects.toThrow();
    } finally {
      await platformApp.$disconnect();
    }
    // The trigger holds for the migrator too: what was assigned never changes.
    await expect(migrator.tenantProfileAssignment.updateMany({ where: { tenantId: t.id }, data: { contentHash: '1'.repeat(64) } })).rejects.toThrow(/can.t change/);
  });

  it('a snapshot is visible only inside its own institution', async () => {
    const [a, b] = await Promise.all([institution('ACTIVE'), institution('ACTIVE')]);
    await pass.pass();
    const seenFromB = await shards.tx(b.shardId, b.id, (tx) => tx.institutionProfile.findMany({ where: { tenantId: a.id }, select: { id: true } }));
    expect(seenFromB).toEqual([]);
    expect((await snapshots(a)).every((s) => s.tenantId === a.id)).toBe(true);
    // And B can't write one into A.
    await expect(
      shards.tx(b.shardId, b.id, (tx) =>
        tx.institutionProfile.create({ data: { tenantId: a.id, template: 'university', templateVersion: 2, contentHash: hashOf('university'), profile: {}, source: 'BACKFILL' } }),
      ),
    ).rejects.toThrow();
  });
});
