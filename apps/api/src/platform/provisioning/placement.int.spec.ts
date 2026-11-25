/**
 * Spec 0039 Q7 (as the owner changed it on 2026-11-24), PR C: placement by level against the real platform database.
 * The console's create request through the platform API's HTTP stack: a pooled institution under its pool's capacity,
 * a dedicated one claiming a READY database in its own transaction (one statement, SKIP LOCKED), and both refusals.
 * Then the database's own rule (`tenant_place`), for the console's and the app's role, and the runtime roles' grants
 * (Q15, T39). The development database holds other ready shards, so each claim test holds those locked meanwhile: the
 * claim must pass over them, as it passes over another request's. Every row made here is removed at the end.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LocalKeyProvider } from '@univarse/crypto';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../modules/identity/password.js';
import { PlatformSessions } from '../identity/sessions.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { freePoolDatabase } from '../../testing/scratch-pool.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'plc-';
const PASSWORD = 'Correct-Horse-Battery-9';
const HOST = 'console.univarse.localhost';
const INVITE_KEY = new LocalKeyProvider('provisioning', randomBytes(32).toString('base64'));
const PLATFORM_MIGRATOR = process.env.PLATFORM_MIGRATOR_URL ?? '';

let app: NestFastifyApplication;
let consoleDb: PlatformClient;
let appDb: PlatformClient;
let migrator: PlatformClient;
let owner = '';
const staffIds: string[] = [];
const shardIds: string[] = [];

async function call(body: unknown, key: string = randomUUID()) {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/api/platform/v1/tenants',
      remoteAddress: `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`,
      headers: {
        host: HOST,
        'sec-fetch-site': 'same-origin',
        cookie: owner,
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

function request(over: Record<string, unknown> = {}) {
  const tag = randomBytes(4).toString('hex');
  return {
    slug: `${PREFIX}${tag}`,
    legalName: `Placement Test College ${tag}`,
    shortName: `PTC${tag}`.toUpperCase(),
    type: 'COLLEGE_OF_EDUCATION',
    ownership: 'STATE',
    template: 'college-of-education',
    state: 'Oyo',
    products: [],
    admin: { displayName: 'Bisi Akande', email: `itadmin-${tag}@inst.test`, username: 'itadmin' },
    ...over,
  };
}

const suffix = () => randomBytes(6).toString('hex');

/** A registered shard (no database behind it: the console never opens one). */
async function shard(
  kind: 'DEDICATED' | 'POOL',
  status: 'READY' | 'ACTIVE' | 'MAINTENANCE' | 'RETIRED',
  capacity = 1,
): Promise<string> {
  const s = suffix();
  const server = await migrator.dbServer.findUniqueOrThrow({
    where: { name: 'local' },
    select: { id: true },
  });
  const [name, database, secretRef, poolSize] =
    kind === 'DEDICATED'
      ? [`t-${s}`, `univarse_t_${s}`, 'UNUSED_DATABASE_URL', 3]
      : [`plc-pool-${s}`, await freePoolDatabase(migrator, server.id), 'UNUSED_DATABASE_URL', 10];
  const { id } = await migrator.shard.create({
    data: {
      name,
      kind,
      secretRef,
      region: 'local',
      serverId: server.id,
      database,
      capacity,
      poolSize,
      status,
    },
    select: { id: true },
  });
  shardIds.push(id);
  return id;
}
const statusOf = async (id: string) =>
  (await migrator.shard.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/**
 * Runs `fn` while another transaction holds every READY dedicated shard but `keep` locked (FOR UPDATE), as a
 * concurrent claim would: the claim's SKIP LOCKED must pass over them.
 */
async function withOthersLocked<T>(keep: readonly string[], fn: () => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: PLATFORM_MIGRATOR });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT id FROM shard WHERE kind = 'DEDICATED' AND status = 'READY' AND NOT (id = ANY($1::uuid[])) FOR UPDATE`,
      [keep],
    );
    return await fn();
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** Every active pool's capacity set to `room` places more than it holds (not purged); restored after `fn`. */
async function withPoolRoom<T>(room: number, fn: () => Promise<T>): Promise<T> {
  const pools = await migrator.shard.findMany({
    where: { kind: 'POOL', status: 'ACTIVE' },
    select: { id: true, capacity: true },
  });
  try {
    for (const p of pools) {
      const held = await migrator.tenant.count({
        where: { shardId: p.id, status: { not: 'PURGED' } },
      });
      await migrator.shard.update({ where: { id: p.id }, data: { capacity: held + room } });
    }
    return await fn();
  } finally {
    for (const p of pools)
      await migrator.shard.update({ where: { id: p.id }, data: { capacity: p.capacity } });
  }
}

/** The database's refusal text, whatever the client wrapped it in. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    const text = `${(e as { meta?: { message?: string } }).meta?.message ?? ''} ${(e as Error).message}`;
    return /tenant_shard_(full|not_open)/.exec(text)?.[0] ?? `other: ${text.slice(0, 120)}`;
  }
}

/** A raw insert with the console's granted columns, as the create request makes it. */
const insertAs = (db: PlatformClient, shardId: string, slug = `${PREFIX}${suffix()}`) =>
  db.$executeRaw`INSERT INTO tenant (id, slug, legal_name, short_name, type, ownership, shard_id, template, updated_at)
                 VALUES (${randomUUID()}::uuid, ${slug}, 'Placement Rule College', 'PRC', 'UNIVERSITY'::"TenantType", 'PRIVATE'::"TenantOwnership", ${shardId}::uuid, 'university@1', now())`;

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), {
    provisioningKeys: INVITE_KEY,
  });
  consoleDb = app.get(CONSOLE_DB);
  appDb = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
  migrator = createPlatformClient(PLATFORM_MIGRATOR);
  const { id } = await consoleDb.platformUser.create({
    data: {
      email: `plc-owner-${suffix()}@staff.test`,
      displayName: 'Placement Owner',
      role: 'OWNER',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true },
  });
  staffIds.push(id);
  const now = new Date();
  const { token } = await consoleDb.$transaction((tx) =>
    app
      .get(PlatformSessions)
      .create(
        tx,
        id,
        { ip: '127.0.0.1', userAgent: 'test' },
        { mfaAt: now, restricted: false, stepUpAt: now },
      ),
  );
  owner = `__Host-uv_console_sid=${token}`;
});

afterAll(async () => {
  await consoleDb.platformSession.updateMany({
    where: { userId: { in: staffIds }, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: 'test_retired' },
  });
  await consoleDb.platformUser.updateMany({
    where: { id: { in: staffIds } },
    data: { role: 'READ_ONLY', isActive: false },
  });
  await pruneTestTenants(
    {
      platformMigratorUrl: PLATFORM_MIGRATOR,
      tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL,
    },
    PREFIX,
  );
  await migrator.tenant.deleteMany({ where: { shardId: { in: shardIds } } });
  await migrator.shard.deleteMany({ where: { id: { in: shardIds } } });
  await Promise.all([appDb.$disconnect(), migrator.$disconnect()]);
  await app.close();
});

describe('[Q7] a dedicated institution claims its database at creation', () => {
  it('claims a READY one: the shard ACTIVE, the institution on it as DEDICATED, the claim audited with its level', async () => {
    const ready = await shard('DEDICATED', 'READY');
    const res = await withOthersLocked([ready], () => call(request({ level: 'DEDICATED' })));
    expect(res.status).toBe(202);
    const t = await migrator.tenant.findUniqueOrThrow({
      where: { id: res.body.tenantId as string },
      select: { shardId: true, tier: true, status: true },
    });
    expect(t).toEqual({ shardId: ready, tier: 'DEDICATED', status: 'REQUESTED' });
    expect(await statusOf(ready)).toBe('ACTIVE');
    const event = await migrator.platformAuditEvent.findFirstOrThrow({
      where: {
        tenantId: res.body.tenantId as string,
        action: 'platform.tenant.provisioning_requested',
      },
      select: { metadata: true },
    });
    expect(event.metadata).toMatchObject({ level: 'DEDICATED', shardId: ready });
  });

  it('none ready: 409 provisioning.no_ready_shard, and nothing is written', async () => {
    const body = request({ level: 'DEDICATED' });
    const res = await withOthersLocked([], () => call(body));
    expect([res.status, res.body.code]).toEqual([409, 'provisioning.no_ready_shard']);
    expect(await migrator.tenant.count({ where: { slug: body.slug } })).toBe(0);
    expect(
      await migrator.platformAuditEvent.count({
        where: {
          action: 'platform.tenant.provisioning_requested',
          metadata: { path: ['slug'], equals: body.slug },
        },
      }),
    ).toBe(0);
  });

  it('a request refused later in its transaction gives its claim back: a taken subdomain leaves the database READY', async () => {
    const ready = await shard('DEDICATED', 'READY');
    const res = await withOthersLocked([ready], () =>
      call(request({ level: 'DEDICATED', slug: 'demo-uni' })),
    );
    expect([res.status, res.body.code]).toEqual([409, 'tenant.slug_taken']);
    expect(await statusOf(ready)).toBe('READY');
  });

  it('two requests at once never claim the same database', async () => {
    const a = await shard('DEDICATED', 'READY');
    const b = await shard('DEDICATED', 'READY');
    const [one, two] = await withOthersLocked([a, b], () =>
      Promise.all([call(request({ level: 'DEDICATED' })), call(request({ level: 'DEDICATED' }))]),
    );
    expect([one.status, two.status]).toEqual([202, 202]);
    const placed = await migrator.tenant.findMany({
      where: { id: { in: [one.body.tenantId as string, two.body.tenantId as string] } },
      select: { shardId: true },
    });
    expect(placed.map((p) => p.shardId).sort()).toEqual([a, b].sort());
    expect([await statusOf(a), await statusOf(b)]).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('only the console may claim, and only through the function: the app role may not execute it', async () => {
    expect(await refusal(appDb.$queryRaw`SELECT public.claim_ready_shard()`)).toMatch(
      /permission denied/,
    );
  });
});

describe('[Q7] a pooled institution goes to a pool with room', () => {
  it('no level means pooled: the emptiest active pool, as POOLED', async () => {
    const res = await call(request());
    expect(res.status).toBe(202);
    const t = await migrator.tenant.findUniqueOrThrow({
      where: { id: res.body.tenantId as string },
      select: { tier: true, shard: { select: { kind: true, status: true } } },
    });
    expect(t).toEqual({ tier: 'POOLED', shard: { kind: 'POOL', status: 'ACTIVE' } });
  });

  it('takes the last place in a pool, then every pool full is 409 provisioning.no_pool_room with nothing written', async () => {
    await withPoolRoom(1, async () => {
      expect((await call(request({ level: 'POOLED' }))).status).toBe(202);
      const body = request({ level: 'POOLED' });
      const full = await call(body);
      expect([full.status, full.body.code]).toEqual([409, 'provisioning.no_pool_room']);
      expect(await migrator.tenant.count({ where: { slug: body.slug } })).toBe(0);
    });
  });

  it('two requests for the last place: one is placed, the other is refused as full, never both placed', async () => {
    await withPoolRoom(1, async () => {
      const both = await Promise.all([call(request()), call(request())]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(both.find((r) => r.status === 409)?.body.code).toBe('provisioning.no_pool_room');
    });
  });

  it('a purged institution leaves its place', async () => {
    await withPoolRoom(1, async () => {
      const first = await call(request());
      expect(first.status).toBe(202);
      await migrator.tenant.update({
        where: { id: first.body.tenantId as string },
        data: { status: 'PURGED' },
      });
      expect((await call(request())).status).toBe(202);
    });
  });
});

describe('[Q7] the database holds placement for the runtime roles (tenant_place)', () => {
  it('a shard that is not ACTIVE takes no one: READY (claimed first), MAINTENANCE, RETIRED', async () => {
    for (const status of ['READY', 'MAINTENANCE', 'RETIRED'] as const) {
      const id = await shard('DEDICATED', status);
      expect([status, await refusal(insertAs(consoleDb, id))]).toEqual([
        status,
        'tenant_shard_not_open',
      ]);
      expect([status, await refusal(insertAs(appDb, id))]).toEqual([
        status,
        'tenant_shard_not_open',
      ]);
      // No database stands behind it: retired at once, so nothing else here or in a later file reaches for it.
      await migrator.shard.update({ where: { id }, data: { status: 'RETIRED' } });
    }
  });

  it('a dedicated database takes one institution, ever, and its tier is DEDICATED', async () => {
    const id = await shard('DEDICATED', 'ACTIVE');
    const slug = `${PREFIX}${suffix()}`;
    expect(await refusal(insertAs(consoleDb, id, slug))).toBe('accepted');
    expect(
      (await migrator.tenant.findUniqueOrThrow({ where: { slug }, select: { tier: true } })).tier,
    ).toBe('DEDICATED');
    expect(await refusal(insertAs(appDb, id))).toBe('tenant_shard_full');
    // Not even once its institution is purged: the database is retired, never reused.
    await migrator.tenant.update({ where: { slug }, data: { status: 'PURGED' } });
    expect(await refusal(insertAs(consoleDb, id))).toBe('tenant_shard_full');
  });

  it('a pool takes up to its capacity, for every runtime role, and its tier is POOLED', async () => {
    const id = await shard('POOL', 'ACTIVE', 2);
    expect(await refusal(insertAs(consoleDb, id))).toBe('accepted');
    expect(await refusal(insertAs(appDb, id))).toBe('accepted');
    expect(await refusal(insertAs(consoleDb, id))).toBe('tenant_shard_full');
    expect(await refusal(insertAs(appDb, id))).toBe('tenant_shard_full');
    expect(
      await migrator.tenant.findMany({ where: { shardId: id }, select: { tier: true } }),
    ).toEqual([{ tier: 'POOLED' }, { tier: 'POOLED' }]);
    await migrator.shard.update({ where: { id }, data: { status: 'RETIRED' } });
  });

  it('a tier can never disagree with the shard: set against it, it follows the shard', async () => {
    const pool = await migrator.shard.findUniqueOrThrow({
      where: { name: 'pool-01' },
      select: { id: true },
    });
    const slug = `${PREFIX}${suffix()}`;
    await insertAs(appDb, pool.id, slug);
    await appDb.tenant.update({ where: { slug }, data: { tier: 'DEDICATED' } });
    expect(
      (await migrator.tenant.findUniqueOrThrow({ where: { slug }, select: { tier: true } })).tier,
    ).toBe('POOLED');
  });

  it('moving an institution onto a shard is held to the same rules', async () => {
    const pool = await migrator.shard.findUniqueOrThrow({
      where: { name: 'pool-01' },
      select: { id: true },
    });
    const slug = `${PREFIX}${suffix()}`;
    await insertAs(appDb, pool.id, slug);
    const retired = await shard('POOL', 'RETIRED', 50);
    expect(
      await refusal(appDb.tenant.update({ where: { slug }, data: { shardId: retired } })),
    ).toBe('tenant_shard_not_open');
  });
});

describe('[Q15, T39] the runtime roles can create no database and write no shard', () => {
  const ROLES = [
    'univarse_app',
    'univarse_app_platform',
    'univarse_console',
    'univarse_relay_platform',
  ];

  it('no CREATEDB, no CREATEROLE, no superuser, no replication, no RLS bypass', async () => {
    const rows = await migrator.$queryRaw<
      {
        rolname: string;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolsuper: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }[]
    >`
      SELECT rolname, rolcreatedb, rolcreaterole, rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY(${ROLES}::text[]) ORDER BY rolname`;
    expect(rows.map((r) => r.rolname)).toEqual([...ROLES].sort());
    for (const r of rows)
      expect(r).toEqual({
        rolname: r.rolname,
        rolcreatedb: false,
        rolcreaterole: false,
        rolsuper: false,
        rolreplication: false,
        rolbypassrls: false,
      });
  });

  it('none may insert, update or delete a shard or a server; the console may claim through the function alone', async () => {
    const rows = await migrator.$queryRaw<
      { role: string; tbl: string; priv: string; ok: boolean }[]
    >`
      SELECT r AS role, t AS tbl, p AS priv, has_table_privilege(r, 'public.' || t, p) AS ok
      FROM unnest(${ROLES.filter((r) => r !== 'univarse_app')}::text[]) r, unnest(ARRAY['shard', 'db_server']) t, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p`;
    expect(rows.filter((r) => r.ok)).toEqual([]);
    const exec = await migrator.$queryRaw<{ role: string; claim: boolean; place: boolean }[]>`
      SELECT r AS role, has_function_privilege(r, 'public.claim_ready_shard()', 'EXECUTE') AS claim,
             has_function_privilege(r, 'public.place_tenant()', 'EXECUTE') AS place
      FROM unnest(${ROLES.filter((r) => r !== 'univarse_app')}::text[]) r ORDER BY r`;
    expect(exec).toEqual([
      { role: 'univarse_app_platform', claim: false, place: false },
      { role: 'univarse_console', claim: true, place: false },
      { role: 'univarse_relay_platform', claim: false, place: false },
    ]);
  });

  it('shard health: the worker writes it, the console reads it, neither deletes it', async () => {
    const rows = await migrator.$queryRaw<{ role: string; priv: string; ok: boolean }[]>`
      SELECT r AS role, p AS priv, has_table_privilege(r, 'public.shard_health', p) AS ok
      FROM unnest(ARRAY['univarse_app_platform', 'univarse_console']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p ORDER BY r, p`;
    expect(rows.filter((r) => r.ok).map((r) => `${r.role} ${r.priv}`)).toEqual([
      'univarse_app_platform INSERT',
      'univarse_app_platform SELECT',
      'univarse_console SELECT',
    ]);
    // UPDATE on the check's own columns only: never which shard a row is.
    const [cols] = await migrator.$queryRaw<{ some: boolean; shard: boolean; console: boolean }[]>`
      SELECT has_any_column_privilege('univarse_app_platform', 'public.shard_health', 'UPDATE') AS some,
             has_column_privilege('univarse_app_platform', 'public.shard_health', 'shard_id', 'UPDATE') AS shard,
             has_any_column_privilege('univarse_console', 'public.shard_health', 'UPDATE') AS console`;
    expect(cols).toEqual({ some: true, shard: false, console: false });
  });
});
