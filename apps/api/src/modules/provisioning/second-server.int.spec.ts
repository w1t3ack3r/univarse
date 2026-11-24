/**
 * Spec 0039 Q14, acceptance 2: a dedicated cluster is the same code path as a dedicated database on the local server.
 * A second PostgreSQL (`postgres:18`, started here with `docker run` and removed at the end: a random local port, a
 * random superuser password held only in memory) gets UniVarse's roles from the bootstrap's own code and a dedicated
 * database made as `pnpm stack:shards ready` makes one. It is registered on the development platform as a server of
 * its own, with its own URL templates in the environment (Q2, Q4), and an institution is provisioned onto it through
 * the console's create request and the worker's steps. Its rows are there, and nowhere on the first server.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LocalKeyProvider } from '@univarse/crypto';
import {
  createPlatformClient,
  createTenantShardClient,
  withTenantTx,
  type PlatformClient,
  type TenantShardClient,
} from '@univarse/db';
import { bootstrap, ROLES, type RoleKey } from '@univarse/db-ops';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURGE_TABLE_ORDER } from '../../cli/purge.js';
import { loadConfig } from '../../config/config.js';
import { PlatformSessions } from '../../platform/identity/sessions.js';
import { createPlatformApp } from '../../platform/platform-app.js';
import { CONSOLE_DB } from '../../platform/platform-config.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import {
  dropDedicatedShard,
  readyDedicatedShard,
  type DedicatedShard,
  type TestServer,
} from '../../testing/dedicated-shard.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { hashPassword } from '../identity/password.js';
import { ProvisioningRunner } from './provisioning-runner.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'ded-';
const IMAGE = 'postgres:18';
const PLATFORM_MIGRATOR = process.env.PLATFORM_MIGRATOR_URL ?? '';
const INVITE_KEY = new LocalKeyProvider('provisioning', randomBytes(32).toString('base64'));
const tag = randomBytes(4).toString('hex');
const SERVER = `second-${tag}`;
const SECRET_REF = `DB_SERVER_T${tag.toUpperCase()}`;

let container = '';
let port = '';
const superuser = randomBytes(24).toString('hex');
const passwords = Object.fromEntries(
  Object.keys(ROLES).map((k) => [k, randomBytes(24).toString('hex')]),
) as Record<RoleKey, string>;
let server: TestServer;
let ded: DedicatedShard;
let migrator: PlatformClient;
let consoleApp: NestFastifyApplication;
let worker: INestApplicationContext;
let there: TenantShardClient;
let here: TenantShardClient;
const staff: string[] = [];
const t = { id: '', slug: `${PREFIX}${tag}` };

const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('docker', args, { encoding: 'utf8', env, timeout: 120_000 });
const at = (user: string, password: string, database: string) =>
  `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;

async function connectAsSuperuser(database: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: at('postgres', superuser, database) });
  await c.connect();
  return c;
}

/** The image's first start initialises, restarts, then listens on TCP: a TCP connection means it's ready. */
async function untilReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const c = await connectAsSuperuser('postgres');
      await c.end();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function rowsIn(db: TenantShardClient, tenantId: string): Promise<number> {
  let n = 0;
  await withTenantTx(db, tenantId, async (tx) => {
    for (const table of PURGE_TABLE_ORDER)
      n +=
        (
          await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1::uuid`,
            tenantId,
          )
        )[0]?.n ?? 0;
  });
  return n;
}

beforeAll(async () => {
  // The superuser's password reaches docker through its environment, never its command line.
  const run = docker(
    [
      'run',
      '-d',
      '--rm',
      '--label',
      'univarse.test=second-server',
      '-e',
      'POSTGRES_PASSWORD',
      '-p',
      '127.0.0.1::5432',
      IMAGE,
    ],
    { ...process.env, POSTGRES_PASSWORD: superuser },
  );
  if (run.status !== 0)
    throw new Error(`docker run ${IMAGE} failed: ${run.stderr.trim().slice(0, 300)}`);
  container = run.stdout.trim();
  const mapped = docker(['port', container, '5432/tcp']).stdout.trim().split('\n')[0] ?? '';
  port = mapped.split(':').at(-1) ?? '';
  if (!/^\d+$/.test(port)) throw new Error(`no port mapped for the second server (${mapped})`);
  await untilReady();
  await bootstrap({ connect: connectAsSuperuser, passwords, migratorCreatedb: false });

  // Q2, Q4: the server's row on the platform, its templates in the environment as a deploy would put them.
  process.env[`${SECRET_REF}_APP_URL`] = at(ROLES.app, passwords.app, '{database}');
  process.env[`${SECRET_REF}_MIGRATOR_URL`] = at(ROLES.migrator, passwords.migrator, '{database}');
  migrator = createPlatformClient(PLATFORM_MIGRATOR);
  await migrator.dbServer.create({
    data: {
      name: SERVER,
      region: 'test',
      maxConnections: 100,
      reservedConnections: 15,
      secretRef: SECRET_REF,
    },
  });
  server = {
    name: SERVER,
    migratorTemplate: at(ROLES.migrator, passwords.migrator, '{database}'),
    admin: connectAsSuperuser,
    from: 'postgres',
  };
  ded = await readyDedicatedShard(server, PLATFORM_MIGRATOR);
  there = createTenantShardClient(ded.migratorUrl);
  here = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);

  // The console claims it (every other ready shard held by another transaction), and the worker provisions there.
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), {
    provisioningKeys: INVITE_KEY,
  });
  const consoleDb = consoleApp.get<PlatformClient>(CONSOLE_DB);
  const { id } = await consoleDb.platformUser.create({
    data: {
      email: `ded-owner-${tag}@staff.test`,
      displayName: 'Second Server Owner',
      role: 'OWNER',
      passwordHash: await hashPassword('Correct-Horse-Battery-9'),
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
  const lock = new pg.Client({ connectionString: PLATFORM_MIGRATOR });
  await lock.connect();
  let res: { statusCode: number; body: string };
  try {
    await lock.query('BEGIN');
    await lock.query(
      `SELECT id FROM shard WHERE kind = 'DEDICATED' AND status = 'READY' AND id <> $1::uuid FOR UPDATE`,
      [ded.id],
    );
    res = await consoleApp
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/platform/v1/tenants',
        remoteAddress: `127.0.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`,
        headers: {
          host: 'console.univarse.localhost',
          'sec-fetch-site': 'same-origin',
          cookie: `__Host-uv_console_sid=${token}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          slug: t.slug,
          legalName: `Second Server Polytechnic ${tag}`,
          shortName: `SSP${tag}`.toUpperCase().slice(0, 12),
          type: 'POLYTECHNIC',
          ownership: 'FEDERAL',
          template: 'polytechnic',
          level: 'DEDICATED',
          state: 'Kano',
          products: [],
          admin: {
            displayName: 'Aisha Bello',
            email: `itadmin-${tag}@inst.test`,
            username: 'itadmin',
          },
        }),
      });
  } finally {
    await lock.query('ROLLBACK').catch(() => undefined);
    await lock.end();
  }
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
  expect(await worker.get(ProvisioningRunner).run(body.jobId)).toBe('done');
}, 240_000);

afterAll(async () => {
  // The container is removed whatever happens before: one left running holds a port and memory.
  try {
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
    await Promise.all([there.$disconnect(), here.$disconnect()]);
    await pruneTestTenants(
      {
        platformMigratorUrl: PLATFORM_MIGRATOR,
        tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL,
      },
      PREFIX,
    );
    await dropDedicatedShard(ded, PLATFORM_MIGRATOR);
    await migrator.dbServer.deleteMany({ where: { name: SERVER } });
    await migrator.$disconnect();
  } finally {
    if (container) docker(['rm', '-f', container]);
  }
}, 120_000);

describe('[Q14] a dedicated institution on a second server', () => {
  it('is provisioned there through the same steps: DEDICATED, on a shard of the second server', async () => {
    const row = await migrator.tenant.findUniqueOrThrow({
      where: { id: t.id },
      select: {
        tier: true,
        status: true,
        shard: { select: { id: true, status: true, server: { select: { name: true } } } },
      },
    });
    expect(row).toEqual({
      tier: 'DEDICATED',
      status: 'ONBOARDING',
      shard: { id: ded.id, status: 'ACTIVE', server: { name: SERVER } },
    });
  });

  it('its rows are on the second server, and none on the first', async () => {
    expect(await rowsIn(there, t.id)).toBeGreaterThan(0);
    expect(await rowsIn(here, t.id)).toBe(0);
  });

  it('is isolated there: the pool’s institution, opened on its shard, reads nothing', async () => {
    const shards = worker.get(ShardRegistry);
    const demo = (
      await migrator.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' }, select: { id: true } })
    ).id;
    expect(await shards.tx(ded.id, demo, (tx) => tx.userAccount.count())).toBe(0);
    expect(await shards.tx(ded.id, t.id, (tx) => tx.userAccount.count())).toBeGreaterThan(0);
  });

  it('the second server keeps its databases to the roles it was given: the app may connect to the dedicated one alone', async () => {
    const c = await connectAsSuperuser('postgres');
    try {
      const r = await c.query<{ datname: string; ok: boolean }>(
        `SELECT datname, has_database_privilege('univarse_app', datname, 'CONNECT') AS ok FROM pg_database WHERE datname IN ('postgres', 'template1', $1) ORDER BY datname`,
        [ded.database],
      );
      expect(r.rows).toEqual([
        { datname: 'postgres', ok: false },
        { datname: 'template1', ok: false },
        { datname: ded.database, ok: true },
      ]);
    } finally {
      await c.end();
    }
  });
});
