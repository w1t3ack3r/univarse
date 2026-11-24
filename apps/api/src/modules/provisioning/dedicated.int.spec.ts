/**
 * Spec 0039 PR C, acceptance 2 and 6 (Q7, Q15): a dedicated institution provisioned end to end, beside `demo-uni` on
 * the pool. A real dedicated database is made as `pnpm stack:shards ready` makes one; the console's create request
 * claims it (the development database's other ready shards held locked meanwhile, as another request would); the
 * worker runs the same eight steps as for a pooled one. Then:
 *   - its rows exist in its own database and nowhere on the pool;
 *   - each institution's host authenticates only its own people, and each one's id on the other's shard reads nothing;
 *   - the backup's facts and the rehearsal's chain check cover it, and pass over it while its shard is in maintenance.
 * Everything made here is removed at the end, its database dropped.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FieldCrypto, LocalKeyProvider } from '@univarse/crypto';
import {
  createPlatformClient,
  createTenantShardClient,
  forTenant,
  withTenantTx,
  type PlatformClient,
  type TenantShardClient,
} from '@univarse/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFacts, verifyChains, verifyDecrypt } from '../../cli/backup-checks.js';
import { loadConfig } from '../../config/config.js';
import { PURGE_TABLE_ORDER } from '../../cli/purge.js';
import { PlatformSessions } from '../../platform/identity/sessions.js';
import { createPlatformApp } from '../../platform/platform-app.js';
import { CONSOLE_DB } from '../../platform/platform-config.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { createHarness, HOSTS, PASSWORD, type Harness } from '../../testing/int-harness.js';
import {
  dropDedicatedShard,
  localServer,
  readyDedicatedShard,
  type DedicatedShard,
} from '../../testing/dedicated-shard.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { hashPassword } from '../identity/password.js';
import { ProvisioningRunner } from './provisioning-runner.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'ded-';
const CONSOLE = 'console.univarse.localhost';
const INVITE_KEY = new LocalKeyProvider('provisioning', randomBytes(32).toString('base64'));
const PLATFORM_MIGRATOR = process.env.PLATFORM_MIGRATOR_URL ?? '';

let consoleApp: NestFastifyApplication;
let worker: INestApplicationContext;
let h: Harness;
let migrator: PlatformClient;
let pool: TenantShardClient;
let own: TenantShardClient;
let shards: ShardRegistry;
let ded: DedicatedShard;
let poolId = '';
const staff: string[] = [];
const t = { id: '', slug: `${PREFIX}${randomBytes(4).toString('hex')}` };

/** Every tenant table's rows under `tenantId`, in one database, as the migrator under that institution's context. */
async function rowsIn(db: TenantShardClient, tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await withTenantTx(db, tenantId, async (tx) => {
    for (const table of PURGE_TABLE_ORDER)
      out[table] =
        (
          await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1::uuid`,
            tenantId,
          )
        )[0]?.n ?? 0;
  });
  return out;
}
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/** A student who may sign in, made in the institution's own database. */
async function student(db: TenantShardClient, tenantId: string): Promise<string> {
  const username = `DED-${randomBytes(4).toString('hex').toUpperCase()}`;
  const scoped = forTenant(db, tenantId);
  const user = await scoped.userAccount.create({
    data: {
      tenantId,
      username,
      displayName: 'Dedicated Student',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true },
  });
  const role = await scoped.role.findUniqueOrThrow({
    where: { tenantId_key: { tenantId, key: 'STUDENT' } },
    select: { id: true },
  });
  await scoped.roleAssignment.create({
    data: { tenantId, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION' },
  });
  return username;
}

async function withOthersLocked<T>(keep: string, fn: () => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: PLATFORM_MIGRATOR });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT id FROM shard WHERE kind = 'DEDICATED' AND status = 'READY' AND id <> $1::uuid FOR UPDATE`,
      [keep],
    );
    return await fn();
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

beforeAll(async () => {
  migrator = createPlatformClient(PLATFORM_MIGRATOR);
  pool = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (
    await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })
  ).id;
  ded = await readyDedicatedShard(localServer(), PLATFORM_MIGRATOR);
  own = createTenantShardClient(ded.migratorUrl);

  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), {
    provisioningKeys: INVITE_KEY,
  });
  const consoleDb = consoleApp.get<PlatformClient>(CONSOLE_DB);
  const { id } = await consoleDb.platformUser.create({
    data: {
      email: `ded-owner-${randomBytes(4).toString('hex')}@staff.test`,
      displayName: 'Dedicated Owner',
      role: 'OWNER',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true },
  });
  staff.push(id);
  const now = new Date();
  const { token } = await consoleDb.$transaction((tx) =>
    consoleApp
      .get(PlatformSessions)
      .create(
        tx,
        id,
        { ip: '127.0.0.1', userAgent: 'test' },
        { mfaAt: now, restricted: false, stepUpAt: now },
      ),
  );
  const tag = randomBytes(3).toString('hex');
  const res = await withOthersLocked(ded.id, () =>
    consoleApp
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/platform/v1/tenants',
        remoteAddress: `127.0.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`,
        headers: {
          host: CONSOLE,
          'sec-fetch-site': 'same-origin',
          cookie: `__Host-uv_console_sid=${token}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          slug: t.slug,
          legalName: `Dedicated Test University ${tag}`,
          shortName: `DTU${tag}`.toUpperCase(),
          type: 'UNIVERSITY',
          ownership: 'PRIVATE',
          template: 'university',
          level: 'DEDICATED',
          state: 'Lagos',
          products: ['academics'],
          admin: {
            displayName: 'Tunde Bakare',
            email: `itadmin-${tag}@inst.test`,
            username: 'itadmin',
          },
        }),
      }),
  );
  expect(res.statusCode).toBe(202);
  const body = JSON.parse(res.body) as { tenantId: string; jobId: string };
  t.id = body.tenantId;

  const config = loadConfig(
    {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PROVISIONING_RELAY_INTERVAL_MS: '0',
      ONBOARDING_CHECK_INTERVAL_MS: '0',
    },
    'worker',
  );
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, {
      mailer: { send: () => Promise.resolve() },
      subscribe: false,
      provisioningKeys: INVITE_KEY,
      provisioningRetryDelays: [],
    }),
    { logger: false },
  );
  shards = worker.get(ShardRegistry);
  expect(await worker.get(ProvisioningRunner).run(body.jobId)).toBe('done');
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h.close();
  await worker.close();
  const consoleDb = consoleApp.get<PlatformClient>(CONSOLE_DB);
  await consoleDb.platformSession.updateMany({
    where: { userId: { in: staff }, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: 'test_retired' },
  });
  await consoleDb.platformUser.updateMany({
    where: { id: { in: staff } },
    data: { role: 'READ_ONLY', isActive: false },
  });
  await consoleApp.close();
  await Promise.all([pool.$disconnect(), own.$disconnect()]);
  await pruneTestTenants(
    {
      platformMigratorUrl: PLATFORM_MIGRATOR,
      tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL,
    },
    PREFIX,
  );
  await dropDedicatedShard(ded, PLATFORM_MIGRATOR);
  await migrator.$disconnect();
}, 60_000);

describe('[acceptance 2] provisioned through the same steps, onto its own database', () => {
  it('the job done; the institution DEDICATED on the claimed shard, now ACTIVE', async () => {
    const row = await migrator.tenant.findUniqueOrThrow({
      where: { id: t.id },
      select: {
        shardId: true,
        tier: true,
        status: true,
        shard: { select: { status: true, kind: true } },
      },
    });
    expect(row).toMatchObject({
      shardId: ded.id,
      tier: 'DEDICATED',
      status: 'ONBOARDING',
      shard: { status: 'ACTIVE', kind: 'DEDICATED' },
    });
    expect(
      (
        await migrator.provisioningJob.findUniqueOrThrow({
          where: { tenantId: t.id },
          select: { status: true },
        })
      ).status,
    ).toBe('DONE');
  });
});

describe('[acceptance 6, Q15] a dedicated institution is isolated', () => {
  it('its rows exist in its own database, and none under its id on the pool', async () => {
    const mine = await rowsIn(own, t.id);
    expect(mine.user_account).toBeGreaterThan(0);
    expect(mine.role).toBeGreaterThan(0);
    expect(mine.audit_event).toBeGreaterThan(0);
    expect(total(await rowsIn(pool, t.id))).toBe(0);
    // And the pool's institution has none in the dedicated database.
    expect(total(await rowsIn(own, h.tenants.demo))).toBe(0);
  });

  it('each one’s id, opened on the other’s shard, reads nothing', async () => {
    expect(await shards.tx(poolId, t.id, (tx) => tx.userAccount.count())).toBe(0);
    expect(await shards.tx(ded.id, h.tenants.demo, (tx) => tx.userAccount.count())).toBe(0);
    expect(await shards.tx(ded.id, t.id, (tx) => tx.userAccount.count())).toBeGreaterThan(0);
  });

  it('each institution’s host signs in only its own people', async () => {
    const host = `${t.slug}.univarse.localhost`;
    const mine = await student(own, t.id);
    const theirs = (await h.makeUser('demo', { role: 'STUDENT' })).username;
    expect((await h.login(host, mine)).statusCode).toBe(200);
    expect((await h.login(HOSTS.demo, theirs)).statusCode).toBe(200);
    const across = [await h.login(HOSTS.demo, mine), await h.login(host, theirs)];
    expect(across.map((r) => [r.statusCode, (r.json() as { code: string }).code])).toEqual([
      [401, 'auth.invalid_credentials'],
      [401, 'auth.invalid_credentials'],
    ]);
  });
});

describe('[Q13] backups cover a dedicated institution', () => {
  it('the backup facts count its own rows; the chain check verifies it and holds its head', async () => {
    const f = await backupFacts(h.platform, shards);
    expect(f.tenants[t.id]).toMatchObject({ slug: t.slug, chain: { seq: expect.any(String) } });
    expect(f.tenants[t.id]?.counts.user_account).toBe(
      String((await rowsIn(own, t.id)).user_account),
    );
    const c = await verifyChains(h.platform, shards, {
      platform: f.platform.chain,
      tenants: { [t.id]: { chain: f.tenants[t.id]?.chain ?? null } },
    });
    expect(c.problems.filter((p) => p.includes(t.slug) || p.includes(t.id))).toEqual([]);
  });

  it('while its shard is in maintenance, the facts and checks pass over it and name it, and fail nothing', async () => {
    await migrator.shard.update({ where: { id: ded.id }, data: { status: 'MAINTENANCE' } });
    shards.forgetStatuses();
    try {
      const f = await backupFacts(h.platform, shards);
      expect(f.tenants[t.id]).toBeUndefined();
      expect(f.skipped).toContain(t.slug);
      const c = await verifyChains(h.platform, shards, {
        platform: null,
        tenants: { [t.id]: { chain: null } },
      });
      expect(c.skipped).toContain(t.slug);
      expect(c.problems.filter((p) => p.includes(t.id))).toEqual([]);
      expect(
        Object.keys(await verifyDecrypt(h.platform, shards, worker.get(FieldCrypto))),
      ).not.toContain(t.slug);
    } finally {
      await migrator.shard.update({ where: { id: ded.id }, data: { status: 'ACTIVE' } });
      shards.forgetStatuses();
    }
  });
});
