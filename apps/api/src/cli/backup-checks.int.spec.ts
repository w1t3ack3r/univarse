/**
 * Spec 0020 B-14 against the real platform database, tenant shard and key provider (CI's integration suite): the shred
 * drill's tenant, and the facts and checks a backup and a restore rehearsal run. The suites share one database, so
 * every assertion looks at this file's own tenants only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { destroyTenantKeys, FieldCrypto, keyProviderFrom, provisionTenantKey, TenantKeyring, type KeyProvider } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { AuditWriter } from '../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../shared/db/db.module.js';
import { outboxAad } from '../shared/outbox/outbox.js';
import { WorkerModule } from '../worker.module.js';
import { backupFacts, createDrillTenant, verifyChains, verifyDecrypt, verifyUnwrap } from './backup-checks.js';

let ctx: INestApplicationContext;
let platform: PlatformClient;
let shards: ShardRegistry;
let provider: KeyProvider;
let crypto: FieldCrypto;
// A date no other run uses (the day field is random): each drill gets a fresh tenant.
const drill = `shred-drill-2${String(randomBytes(4).readUInt32BE() % 10_000_000).padStart(7, '0')}`;
let drillId = '';
let other: { id: string; slug: string; shardId: string };

beforeAll(async () => {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
  platform = ctx.get<PlatformClient>(PLATFORM_DB);
  shards = ctx.get(ShardRegistry);
  provider = keyProviderFrom(config);
  crypto = ctx.get(FieldCrypto);
  // Another scratch tenant with an encrypted value of its own: the cross-tenant control.
  const shardId = (await platform.shard.findFirstOrThrow({ where: { isActive: true } })).id;
  const t = await platform.tenant.create({
    data: { slug: `bk-other-${randomBytes(3).toString('hex')}`, legalName: 'Backup checks', shortName: 'BK', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'OFFBOARDING', shardId },
  });
  await provisionTenantKey(platform, provider, t.id);
  await shards.tx(shardId, t.id, async (tx) => {
    const id = randomUUID();
    await tx.outboxEvent.create({ data: { id, tenantId: t.id, type: 'test', status: 'DEAD', payloadEnc: await crypto.encrypt(t.id, Buffer.from('x'), outboxAad(t.id, id)) } });
  });
  other = { id: t.id, slug: t.slug, shardId };
}, 60_000);
afterAll(async () => {
  await ctx.close();
});

const create = (slug: string) => createDrillTenant(platform, shards, provider, crypto, ctx.get(AuditWriter), slug);

describe('[D11] the drill tenant', () => {
  it('is created suspended, unreachable (no domain, no product), with a key and three DEAD encrypted values, audited', async () => {
    const r = await create(drill);
    drillId = r.tenantId;
    expect(r).toMatchObject({ tenant: drill, keyVersion: 1, values: 3 });
    const t = await platform.tenant.findUniqueOrThrow({ where: { id: drillId }, include: { domains: true, products: true } });
    expect([t.status, t.domains.length, t.products.length]).toEqual(['SUSPENDED', 0, 0]);
    const rows = await shards.tx(t.shardId, drillId, (tx) => tx.outboxEvent.findMany({ select: { status: true, payloadEnc: true } }));
    expect(rows.map((x) => x.status)).toEqual(['DEAD', 'DEAD', 'DEAD']);
    expect(await platform.platformAuditEvent.count({ where: { tenantId: drillId, action: 'tenant.drill_created' } })).toBe(1);
  });

  it('refuses another name, and a second drill under the same name', async () => {
    await expect(create('demo-uni')).rejects.toThrow(/shred-drill-YYYYMMDD/);
    await expect(create(drill)).rejects.toThrow(/exists/);
  });
});

describe('[B-14] the facts and the checks', () => {
  it('backup-facts: the WAL position, the chain heads, and RLS-scoped counts per tenant (no other tenant\'s rows)', async () => {
    const f = await backupFacts(platform, shards);
    expect(f.platform.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    expect(f.platform.chain?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.tenants[drillId]).toMatchObject({ slug: drill, chain: { seq: '1' } });
    expect(f.tenants[drillId]?.counts.outbox_event).toBe('3');
    expect(f.tenants[drillId]?.counts.audit_event).toBe('1');
    expect(f.tenants[other.id]?.counts.outbox_event).toBe('1');
    expect(Number(f.platform.counts.tenant)).toBeGreaterThanOrEqual(2);
  });

  it('verify-chains: every chain verifies and holds the checkpoint; a changed head is named', async () => {
    const f = await backupFacts(platform, shards);
    const own = (problems: string[]) => problems.filter((p) => p.includes(drill) || p.includes(other.slug));
    expect(own((await verifyChains(platform, shards, { platform: null, tenants: { [drillId]: f.tenants[drillId]!, [other.id]: f.tenants[other.id]! } })).problems)).toEqual([]);
    const tampered = { platform: null, tenants: { [drillId]: { chain: { seq: '1', hash: '00'.repeat(32) } } } };
    expect(own((await verifyChains(platform, shards, tampered)).problems)).toEqual([`${drill}: chain does not hold the checkpoint's head`]);
  });

  it('verify-unwrap and verify-decrypt: ok before the drill\'s destruction; key_destroyed after it, and the other tenant still decrypts', async () => {
    expect((await verifyUnwrap(platform, provider)).failed.filter((k) => k.tenant === drill || k.tenant === other.slug)).toEqual([]);
    expect((await verifyDecrypt(platform, shards, crypto))[drill]).toEqual({ status: 'ok', sampled: 3 });

    await destroyTenantKeys(platform, drillId, null, 'the drill', { op: randomUUID() });
    ctx.get(TenantKeyring).forget(drillId); // a fresh CLI process has no cached key
    const after = await verifyDecrypt(platform, shards, crypto);
    expect(after[drill]).toEqual({ status: 'key_destroyed', sampled: 3 });
    expect(after[other.slug]).toEqual({ status: 'ok', sampled: 1 });
    // A destroyed key is not a key to unwrap: it is neither counted nor failed.
    expect((await verifyUnwrap(platform, provider)).failed.filter((k) => k.tenant === drill)).toEqual([]);
  });
});
