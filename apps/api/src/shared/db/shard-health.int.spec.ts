/**
 * Spec 0039 Q11: the worker's shard health pass against the real platform database, as the worker's own role
 * (univarse_app_platform, whose grants on shard_health are the migration's). A shard in maintenance is checked though
 * no request may reach it; one with no database answers unreachable; one with no URL in the environment, no
 * credentials; a retired one isn't checked. Scratch shards only, removed at the end.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShardRegistry, ShardUnavailableError } from './db.module.js';
import { ShardHealthPass } from './shard-health.js';
import { freePoolDatabase } from '../../testing/scratch-pool.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let app: PlatformClient;
let migrator: PlatformClient;
let registry: ShardRegistry;
let pass: ShardHealthPass;
const made: string[] = [];
const variables: string[] = [];

/** A scratch pool, reached through its own variable (set to pool_01's URL, or left unset). */
async function pool(status: 'MAINTENANCE' | 'RETIRED', reachable: boolean): Promise<string> {
  const variable = `TENANT_POOL_${randomBytes(3).toString('hex').toUpperCase()}_DATABASE_URL`;
  if (reachable) {
    process.env[variable] = process.env.TENANT_POOL_01_DATABASE_URL;
    variables.push(variable);
  }
  const server = await migrator.dbServer.findUniqueOrThrow({
    where: { name: 'local' },
    select: { id: true },
  });
  const { id } = await migrator.shard.create({
    data: {
      name: `hc-pool-${randomBytes(4).toString('hex')}`,
      kind: 'POOL',
      secretRef: variable,
      region: 'local',
      serverId: server.id,
      database: await freePoolDatabase(migrator, server.id),
      capacity: 50,
      poolSize: 10,
      status,
    },
    select: { id: true },
  });
  made.push(id);
  return id;
}

/** A scratch dedicated shard whose database doesn't exist. */
async function missing(): Promise<string> {
  const s = randomBytes(6).toString('hex');
  const server = await migrator.dbServer.findUniqueOrThrow({
    where: { name: 'local' },
    select: { id: true },
  });
  const { id } = await migrator.shard.create({
    data: {
      name: `t-${s}`,
      kind: 'DEDICATED',
      secretRef: 'UNUSED_DATABASE_URL',
      region: 'local',
      serverId: server.id,
      database: `univarse_t_${s}`,
      capacity: 1,
      poolSize: 3,
      status: 'MAINTENANCE',
    },
    select: { id: true },
  });
  made.push(id);
  return id;
}

const health = (shardId: string) => migrator.shardHealth.findUnique({ where: { shardId } });

beforeAll(() => {
  app = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  registry = new ShardRegistry(app);
  pass = new ShardHealthPass(app, registry);
});

afterAll(async () => {
  await migrator.shard.deleteMany({ where: { id: { in: made } } });
  for (const v of variables) Reflect.deleteProperty(process.env, v);
  await registry.onApplicationShutdown();
  await migrator.$disconnect();
});

describe('[Q11] every shard checked once a pass, as the worker', () => {
  it('records the pool as reachable, with its latency', async () => {
    await pass.pass();
    const pool01 = await migrator.shard.findUniqueOrThrow({
      where: { name: 'pool-01' },
      select: { id: true },
    });
    const h = await health(pool01.id);
    expect(h).toMatchObject({ ok: true, errorCode: null });
    expect(h?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h?.lastSuccessAt?.getTime()).toBe(h?.checkedAt.getTime());
  });

  it('checks a shard in maintenance, which no request may reach', async () => {
    const id = await pool('MAINTENANCE', true);
    await expect(registry.client(id)).rejects.toBeInstanceOf(ShardUnavailableError);
    await pass.pass();
    expect(await health(id)).toMatchObject({ ok: true, errorCode: null });
  });

  it('a database that is not there is unreachable; a shard with no URL has no credentials; both keep no success', async () => {
    const gone = await missing();
    const unset = await pool('MAINTENANCE', false);
    expect(await pass.pass()).toBeGreaterThanOrEqual(2);
    expect(await health(gone)).toMatchObject({
      ok: false,
      errorCode: 'unreachable',
      latencyMs: null,
      lastSuccessAt: null,
    });
    expect(await health(unset)).toMatchObject({
      ok: false,
      errorCode: 'no_credentials',
      latencyMs: null,
      lastSuccessAt: null,
    });
  });

  it('a retired shard is not checked', async () => {
    const id = await pool('RETIRED', true);
    await pass.pass();
    expect(await health(id)).toBeNull();
  });

  it('the worker may not remove a check, nor say which shard a check is for', async () => {
    const pool01 = await migrator.shard.findUniqueOrThrow({
      where: { name: 'pool-01' },
      select: { id: true },
    });
    await expect(app.shardHealth.deleteMany({ where: { shardId: pool01.id } })).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.$executeRaw`UPDATE shard_health SET shard_id = shard_id WHERE shard_id = ${pool01.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
  });
});
