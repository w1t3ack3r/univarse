/**
 * Spec 0039 Q10 (S8 PR A): an institution whose shard is in maintenance answers 503 `tenant.maintenance`, in its name
 * and colours, with a Retry-After of 300; a suspension takes precedence. The worker's passes leave it out
 * (`ON_SERVABLE_SHARD`), `ShardRegistry` refuses the shard, and readiness stays green while another shard is ACTIVE.
 * The institution here lives on a scratch dedicated shard (its database is never opened: everything refuses first),
 * so the demo institutions on pool-01 are never touched. Removed at the end.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { ON_SERVABLE_SHARD, ShardRegistry, ShardUnavailableError } from '../db/db.module.js';
import { TenantResolver } from './tenant-resolver.service.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let app: NestFastifyApplication;
let migrator: PlatformClient;
const suffix = randomBytes(6).toString('hex');
const slug = `susp-mnt-${suffix}`;
const host = `${slug}.univarse.localhost`;
let shardId = '';
let tenantId = '';

const get = async (url: string) => {
  const res = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: { host } });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, retryAfter: res.headers['retry-after'] };
};
const setShard = async (status: 'ACTIVE' | 'MAINTENANCE') => {
  await migrator.shard.update({ where: { id: shardId }, data: { status } });
  app.get(TenantResolver).invalidate();
  app.get(ShardRegistry).forgetStatuses();
};

beforeAll(async () => {
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  const server = await migrator.dbServer.findUniqueOrThrow({ where: { name: 'local' }, select: { id: true } });
  shardId = (
    await migrator.shard.create({
      data: { name: `t-${suffix}`, kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', region: 'local', serverId: server.id, database: `univarse_t_${suffix}`, capacity: 1, poolSize: 3, status: 'ACTIVE' },
      select: { id: true },
    })
  ).id;
  tenantId = (
    await migrator.tenant.create({
      data: { slug, legalName: 'Maintained Polytechnic', shortName: 'MPT', type: 'POLYTECHNIC', ownership: 'STATE', status: 'ACTIVE', shardId, tier: 'DEDICATED' },
      select: { id: true },
    })
  ).id;
  // Spec 0039 PR C: placed while the shard is open (the placement trigger), then put in maintenance.
  await migrator.shard.update({ where: { id: shardId }, data: { status: 'MAINTENANCE' } });
  await migrator.tenantDomain.create({ data: { tenantId, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await migrator.tenantBranding.create({ data: { tenantId, primaryColor: '#1F4E79' } });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  await migrator.tenantBranding.deleteMany({ where: { tenantId } });
  await migrator.tenantDomain.deleteMany({ where: { tenantId } });
  await migrator.tenant.deleteMany({ where: { id: tenantId } });
  await migrator.shard.deleteMany({ where: { id: shardId } });
  await migrator.$disconnect();
  await app.close();
});

describe('[spec 0039 Q10] an institution on a shard in maintenance', () => {
  it('answers 503 tenant.maintenance in its name and colours, asking to come back in 5 minutes', async () => {
    for (const url of ['/api/v1/tenant/public-profile', '/api/v1/auth/me']) {
      const r = await get(url);
      expect(r.status).toBe(503);
      expect(r.retryAfter).toBe('300');
      expect(r.body).toMatchObject({ code: 'tenant.maintenance', institution: { legalName: 'Maintained Polytechnic', shortName: 'MPT', primaryColor: '#1F4E79', textColor: expect.any(String) } });
    }
  });

  it('a suspension takes precedence: 423, not 503', async () => {
    await migrator.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    app.get(TenantResolver).invalidate();
    try {
      expect((await get('/api/v1/tenant/public-profile')).body.code).toBe('tenant.suspended');
    } finally {
      await migrator.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
      app.get(TenantResolver).invalidate();
    }
  });

  it('ShardRegistry refuses the shard, and the worker passes’ filter leaves its institution out', async () => {
    await expect(app.get(ShardRegistry).client(shardId)).rejects.toBeInstanceOf(ShardUnavailableError);
    const all = await migrator.tenant.findMany({ where: { id: tenantId }, select: { id: true } });
    const servable = await migrator.tenant.findMany({ where: { id: tenantId, ...ON_SERVABLE_SHARD }, select: { id: true } });
    expect([all.length, servable.length]).toEqual([1, 0]);
  });

  it('readiness stays green while another shard is ACTIVE', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('back in service: the 503 is gone (the database itself is then reached, as for any institution)', async () => {
    await setShard('ACTIVE');
    try {
      const r = await get('/api/v1/tenant/public-profile');
      // The public profile reads the platform only, so it answers once the shard is ACTIVE.
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ slug, legalName: 'Maintained Polytechnic' });
    } finally {
      await setShard('MAINTENANCE');
    }
  });
});
