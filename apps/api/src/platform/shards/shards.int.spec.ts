/**
 * Spec 0039 Q12, PR D: the console's Shards page and its inbox items against the real platform database, through the
 * platform API's HTTP stack as the console's role. Scratch shards (no database behind them: the console never opens
 * one) cover a ready database, a dedicated one with its institution, one in maintenance after a failed run, one
 * unreachable, one never checked and a retired one. Every row made here is removed at the end.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PlatformOps, type PlatformShards } from '@univarse/contracts';
import { createPlatformClient, MINIMUM_READY, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../modules/identity/password.js';
import { PlatformSessions } from '../identity/sessions.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';
import { platformTestConfig } from '../../testing/platform-env.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';
const HOST = 'console.univarse.localhost';

let app: NestFastifyApplication;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let serverId = '';
const staff: string[] = [];
const shardIds: string[] = [];
const tenantIds: string[] = [];
const cookies = new Map<Role, string>();
const made: Record<'ready' | 'dedicated' | 'down' | 'unreachable' | 'unchecked' | 'retired', { id: string; name: string }> = {} as never;

async function as(role: Role): Promise<string> {
  const known = cookies.get(role);
  if (known) return known;
  const { id } = await consoleDb.platformUser.create({ data: { email: `shd-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@staff.test`, displayName: `Shards ${role}`, role, passwordHash: await hashPassword('Correct-Horse-Battery-9') }, select: { id: true } });
  staff.push(id);
  const now = new Date();
  const { token } = await consoleDb.$transaction((tx) => app.get(PlatformSessions).create(tx, id, { ip: '127.0.0.1', userAgent: 'test' }, { mfaAt: now, restricted: false, stepUpAt: now }));
  const cookie = `__Host-uv_console_sid=${token}`;
  cookies.set(role, cookie);
  return cookie;
}

async function get(path: string, role: Role) {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: `/api/platform/v1${path}`, remoteAddress: `127.0.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`, headers: { host: HOST, cookie: await as(role) } });
  return { status: res.statusCode, text: res.body, body: JSON.parse(res.body) as Record<string, unknown> };
}
const shards = async (role: Role = 'OWNER') => PlatformOps.shards.response.parse((await get('/shards', role)).body);
const inbox = async (role: Role = 'OWNER') => ((await get('/inbox', role)).body.items as { type: string; shard?: { id: string }; errorCode?: string | null; institutions?: number; ready?: number }[]);

async function shard(kind: 'POOL' | 'DEDICATED', status: 'READY' | 'ACTIVE' | 'MAINTENANCE' | 'RETIRED'): Promise<{ id: string; name: string }> {
  const s = randomBytes(6).toString('hex');
  const [name, database, capacity, poolSize] = kind === 'DEDICATED' ? [`t-${s}`, `univarse_t_${s}`, 1, 3] : [`shd-pool-${s}`, `univarse_pool_${String(randomInt(10, 99))}`, 50, 10];
  const { id } = await migrator.shard.create({ data: { name, kind, secretRef: 'SHARDS_TEST_DATABASE_URL', region: 'local', serverId, database, capacity, poolSize, status }, select: { id: true } });
  shardIds.push(id);
  return { id, name };
}
const health = (shardId: string, ok: boolean, minutesAgo = 0) =>
  migrator.shardHealth.create({ data: { shardId, ok, checkedAt: new Date(Date.now() - minutesAgo * 60_000), latencyMs: ok ? 4 : null, lastSuccessAt: ok ? new Date() : null, errorCode: ok ? null : 'timeout' } });
const rowOf = (p: PlatformShards, id: string) => p.shards.find((s) => s.id === id);

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = app.get(CONSOLE_DB);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  serverId = (await migrator.dbServer.findUniqueOrThrow({ where: { name: 'local' }, select: { id: true } })).id;

  made.ready = await shard('DEDICATED', 'READY');
  await health(made.ready.id, true);
  made.dedicated = await shard('DEDICATED', 'ACTIVE');
  await health(made.dedicated.id, true);
  const t = await migrator.tenant.create({ data: { slug: `shd-${randomBytes(4).toString('hex')}`, legalName: 'Shards Test University', shortName: 'STU', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE', shardId: made.dedicated.id }, select: { id: true } });
  tenantIds.push(t.id);
  made.down = await shard('DEDICATED', 'MAINTENANCE');
  await health(made.down.id, true);
  // Its run started and failed, as the migrate job records one (a run ends once: the trigger).
  const run = await migrator.migrationRun.create({ data: { jobId: randomUUID(), shardId: made.down.id, database: 'univarse_t_scratch00000', status: 'RUNNING' }, select: { id: true } });
  await migrator.migrationRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), applied: 0, errorCode: 'migrate_failed' } });
  made.unreachable = await shard('POOL', 'ACTIVE');
  await health(made.unreachable.id, false);
  made.unchecked = await shard('POOL', 'ACTIVE');
  made.retired = await shard('DEDICATED', 'RETIRED');
});

afterAll(async () => {
  await consoleDb.platformSession.updateMany({ where: { userId: { in: staff }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: staff } }, data: { role: 'READ_ONLY', isActive: false } });
  await migrator.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  // Migration runs are kept (a trigger refuses their deletion): the shard that has one stays, retired.
  await migrator.shard.updateMany({ where: { id: { in: shardIds } }, data: { status: 'RETIRED' } });
  await migrator.shard.deleteMany({ where: { id: { in: shardIds }, migrationRuns: { none: {} } } });
  await migrator.$disconnect();
  await app.close();
});

describe('[Q12] who may read the Shards page', () => {
  it('OWNER and SUPER_ADMIN; to SUPPORT, FINANCE and READ_ONLY the route is absent (404)', async () => {
    for (const role of ['OWNER', 'SUPER_ADMIN'] as const) expect([role, (await get('/shards', role)).status]).toEqual([role, 200]);
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) expect([role, (await get('/shards', role)).status]).toEqual([role, 404]);
  });

  it('never a connection string, a variable’s name or a password', async () => {
    const { text } = await get('/shards', 'OWNER');
    expect(text).not.toMatch(/postgres(ql)?:\/\/|_URL|DB_SERVER|secret|password/i);
  });
});

describe('[Q12] what it shows, against the database', () => {
  it('the server’s budget, counted as stack:shards counts it', async () => {
    const p = await shards();
    const local = p.servers.find((s) => s.name === 'local');
    const pools = await migrator.shard.aggregate({ where: { serverId, status: { not: 'RETIRED' } }, _sum: { poolSize: true } });
    const sum = pools._sum.poolSize ?? 0;
    expect(local).toMatchObject({ maxConnections: 100, reservedConnections: 15, platformPools: 30, shardPools: sum, left: 100 - 15 - 30 - sum, dedicatedRoom: Math.max(0, Math.floor((100 - 15 - 30 - sum) / 3)) });
  });

  it('each shard: its institutions, its last run and its health; pools first, retired last', async () => {
    const p = await shards();
    const pool01 = await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } });
    expect(rowOf(p, pool01.id)?.institutions).toBe(await migrator.tenant.count({ where: { shardId: pool01.id, status: { not: 'PURGED' } } }));
    expect(rowOf(p, made.dedicated.id)).toMatchObject({ kind: 'DEDICATED', status: 'ACTIVE', institutions: 1, institution: { id: tenantIds[0], name: 'STU' }, server: 'local' });
    expect(rowOf(p, made.ready.id)).toMatchObject({ status: 'READY', institutions: 0, institution: null, health: { ok: true, latencyMs: 4 } });
    expect(rowOf(p, made.down.id)?.lastRun).toMatchObject({ status: 'FAILED', errorCode: 'migrate_failed', applied: 0 });
    expect(rowOf(p, made.unchecked.id)?.health).toBeNull();
    const kinds = p.shards.map((s) => (s.status === 'RETIRED' ? 'z' : s.kind === 'POOL' ? 'a' : 'b'));
    expect(kinds).toEqual([...kinds].sort());
    expect(p.ready).toBe(await migrator.shard.count({ where: { kind: 'DEDICATED', status: 'READY' } }));
    expect(p.minimumReady).toBe(MINIMUM_READY);
  });

  it('warns of maintenance, of a shard unreachable or unchecked; never of a retired one', async () => {
    const { warnings } = await shards();
    expect(warnings).toContainEqual(expect.objectContaining({ type: 'maintenance', shard: made.down.name, errorCode: 'migrate_failed' }));
    expect(warnings).toContainEqual(expect.objectContaining({ type: 'unreachable', shard: made.unreachable.name, errorCode: 'timeout' }));
    expect(warnings).toContainEqual(expect.objectContaining({ type: 'unchecked', shard: made.unchecked.name, checkedAt: null }));
    expect(warnings.some((w) => 'shard' in w && w.shard === made.retired.name)).toBe(false);
    expect(warnings.some((w) => 'shard' in w && w.shard === made.dedicated.name)).toBe(false);
  });

  it('the institution’s page names its shard and its state', async () => {
    const t = (await get(`/tenants/${tenantIds[0] ?? ''}`, 'SUPPORT')).body;
    expect(t.shard).toEqual({ id: made.dedicated.id, name: made.dedicated.name, kind: 'DEDICATED', status: 'ACTIVE', region: 'local' });
  });
});

describe('[Q12] the inbox', () => {
  it('a shard in maintenance is an item, with its run’s code and its institutions, for those who may see shards', async () => {
    expect((await inbox()).filter((i) => i.type === 'shard_maintenance' && i.shard?.id === made.down.id)).toEqual([
      expect.objectContaining({ errorCode: 'migrate_failed', institutions: 0 }),
    ]);
    expect((await inbox('SUPPORT')).some((i) => i.type === 'shard_maintenance' || i.type === 'ready_low')).toBe(false);
  });

  it('it leaves once the shard is back in service', async () => {
    await migrator.shard.update({ where: { id: made.down.id }, data: { status: 'ACTIVE' } });
    try {
      expect((await inbox()).some((i) => i.type === 'shard_maintenance' && i.shard?.id === made.down.id)).toBe(false);
    } finally {
      await migrator.shard.update({ where: { id: made.down.id }, data: { status: 'MAINTENANCE' } });
    }
  });

  it('too few ready dedicated databases is an item, and leaves once there are enough', async () => {
    // This file's own ready one set aside, so the development database's count is the others' (CI's: none).
    await migrator.shard.update({ where: { id: made.ready.id }, data: { status: 'RETIRED' } });
    const count = await migrator.shard.count({ where: { kind: 'DEDICATED', status: 'READY' } });
    const low = (await inbox()).find((i) => i.type === 'ready_low');
    if (count < MINIMUM_READY) expect(low).toEqual({ type: 'ready_low', ready: count, minimum: MINIMUM_READY });
    else expect(low).toBeUndefined();
    for (let n = count; n < MINIMUM_READY; n++) await shard('DEDICATED', 'READY');
    expect((await inbox()).some((i) => i.type === 'ready_low')).toBe(false);
  });
});
