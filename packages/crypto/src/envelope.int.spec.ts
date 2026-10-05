/**
 * Spec 0006 PR A against the real platform DB and Vault Transit (ADR-023).
 * Prereqs: `pnpm db:migrate && pnpm db:seed` (provisions keys), Vault configured (`pnpm dev:vault`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPlatformClient, createTenantShardClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCrypto } from './field-crypto.js';
import { TenantKeyring } from './keyring.js';
import { destroyTenantKeys, provisionTenantKey } from './keys.js';
import { verifyPlatformAuditChain } from './platform-audit.js';
import { KeyUnavailableError, VaultTransitProvider, keyProviderFrom, wrapContext, type KeyProvider } from './providers.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let platform: PlatformClient;
let provider: KeyProvider;
const run = randomBytes(3).toString('hex');

beforeAll(() => {
  platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
  provider = keyProviderFrom({
    KEY_PROVIDER: 'vault',
    VAULT_ADDR: process.env.VAULT_ADDR,
    VAULT_TOKEN: process.env.VAULT_TOKEN,
    VAULT_TRANSIT_MOUNT: process.env.VAULT_TRANSIT_MOUNT,
    VAULT_TRANSIT_KEY: process.env.VAULT_TRANSIT_KEY,
  });
});
afterAll(async () => {
  await platform.$disconnect();
});

/** A throwaway tenant kept out of the resolver and the worker (no domain, OFFBOARDING). */
async function scratchTenant(label: string): Promise<string> {
  const shard = await platform.shard.findFirstOrThrow({ where: { isActive: true } });
  const t = await platform.tenant.create({
    data: {
      slug: `e2e-key-${label}-${run}`,
      legalName: `Key Test ${label}`,
      shortName: `KEY-${label}`.toUpperCase(),
      type: 'UNIVERSITY',
      ownership: 'PRIVATE',
      status: 'OFFBOARDING',
      shardId: shard.id,
    },
  });
  return t.id;
}

describe('[E1][E11] per-tenant data keys, provisioned', () => {
  it('[E11] every seeded tenant has exactly one ACTIVE key, wrapped by the Vault KEK', async () => {
    for (const slug of ['demo-uni', 'test-poly']) {
      const t = await platform.tenant.findUniqueOrThrow({ where: { slug } });
      const active = await platform.tenantDataKey.findMany({ where: { tenantId: t.id, status: 'ACTIVE' } });
      expect(active).toHaveLength(1);
      expect(active[0]!.kekId).toBe(provider.kekId);
      expect(active[0]!.wrappedDek).toMatch(/^vault:v\d+:/);
    }
  });

  it('[E11] provisioning is idempotent', async () => {
    const id = await scratchTenant('idem');
    const first = await provisionTenantKey(platform, provider, id);
    const again = await provisionTenantKey(platform, provider, id);
    expect(first).toEqual({ version: 1, created: true });
    expect(again).toEqual({ version: 1, created: false });
    expect(await platform.tenantDataKey.count({ where: { tenantId: id } })).toBe(1);
    await destroyTenantKeys(platform, id, null, 'test cleanup');
  });

  it('[E1] two tenants never share key material', async () => {
    const [a, b] = [await scratchTenant('a1'), await scratchTenant('b1')];
    await provisionTenantKey(platform, provider, a);
    await provisionTenantKey(platform, provider, b);
    const ring = new TenantKeyring(platform, provider);
    expect((await ring.key(a, 1)).equals(await ring.key(b, 1))).toBe(false);
    await destroyTenantKeys(platform, a, null, 'test cleanup');
    await destroyTenantKeys(platform, b, null, 'test cleanup');
  });
});

describe('[E2][E3] wrapped at rest, apart from the data, behind Vault', () => {
  it('[E2] a wrapped DEK copied to another tenant (or version) does not unwrap', async () => {
    const [a, b] = [await scratchTenant('a2'), await scratchTenant('b2')];
    await provisionTenantKey(platform, provider, a);
    const row = await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: a } });
    await expect(provider.unwrap(row.wrappedDek!, wrapContext(b, 1))).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(provider.unwrap(row.wrappedDek!, wrapContext(a, 2))).rejects.toBeInstanceOf(KeyUnavailableError);
    const dek = await provider.unwrap(row.wrappedDek!, wrapContext(a, 1));
    expect(row.wrappedDek).not.toContain(dek.toString('base64'));
    await destroyTenantKeys(platform, a, null, 'test cleanup');
    await destroyTenantKeys(platform, b, null, 'test cleanup');
  });

  it('[E2] the tenant shard holds no keys: tenant_data_key exists only in the platform DB', async () => {
    const shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
    try {
      const rows = await shard.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tenant_data_key'`;
      expect(rows[0]!.n).toBe(0);
    } finally {
      await shard.$disconnect();
    }
  });

  it('[E3] the app token can only encrypt/decrypt: it cannot read, export or rotate the KEK', async () => {
    const addr = process.env.VAULT_ADDR!;
    const headers = { 'x-vault-token': process.env.VAULT_TOKEN! };
    const key = process.env.VAULT_TRANSIT_KEY ?? 'univarse-kek';
    expect((await fetch(`${addr}/v1/transit/keys/${key}`, { headers })).status).toBe(403);
    expect((await fetch(`${addr}/v1/transit/export/encryption-key/${key}`, { headers })).status).toBe(403);
    expect((await fetch(`${addr}/v1/transit/keys/${key}/rotate`, { method: 'POST', headers })).status).toBe(403);
  });
});

describe('[E6] fail closed', () => {
  it('[E6] an unreachable Vault raises KeyUnavailableError, never a fallback', async () => {
    const down = new VaultTransitProvider({ addr: 'http://127.0.0.1:9', token: 'x', mount: 'transit', key: 'univarse-kek', timeoutMs: 500 });
    await expect(down.wrap(randomBytes(32), wrapContext('t', 1))).rejects.toMatchObject({ reason: 'provider_unavailable' });
  });
});

describe('[E10][E12] crypto-shredding, audited', () => {
  it('[E10] destroying tenant A’s keys makes only A’s data undecryptable', async () => {
    const [a, b] = [await scratchTenant('a3'), await scratchTenant('b3')];
    await provisionTenantKey(platform, provider, a);
    await provisionTenantKey(platform, provider, b);
    const fc = new FieldCrypto(new TenantKeyring(platform, provider));
    const secretA = await fc.encrypt(a, Buffer.from('A-secret'), `${a}:u:totp`);
    const secretB = await fc.encrypt(b, Buffer.from('B-secret'), `${b}:u:totp`);

    expect(await destroyTenantKeys(platform, a, null, 'offboarding test')).toBe(1);

    // A fresh keyring (nothing cached) can no longer read A, and still reads B.
    const fresh = new FieldCrypto(new TenantKeyring(platform, provider));
    await expect(fresh.decrypt(a, secretA, `${a}:u:totp`)).rejects.toMatchObject({ reason: 'key_destroyed' });
    expect((await fresh.decrypt(b, secretB, `${b}:u:totp`)).toString()).toBe('B-secret');
    const row = await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: a } });
    expect(row).toMatchObject({ status: 'DESTROYED', wrappedDek: null });
    expect(row.destroyedAt).toBeInstanceOf(Date);
    await destroyTenantKeys(platform, b, null, 'test cleanup');
  });

  it('[E10] key rows cannot be deleted by the app role (shredding is erase-in-place, audited)', async () => {
    const a = await scratchTenant('a4');
    await provisionTenantKey(platform, provider, a);
    await expect(platform.tenantDataKey.deleteMany({ where: { tenantId: a } })).rejects.toThrow(/permission denied/);
    await destroyTenantKeys(platform, a, null, 'test cleanup');
  });

  it('[E12] key lifecycle events land in the platform chain, which verifies, with no key material', async () => {
    const a = await scratchTenant('a5');
    await provisionTenantKey(platform, provider, a);
    await destroyTenantKeys(platform, a, null, 'audit test');
    const events = await platform.platformAuditEvent.findMany({ where: { tenantId: a }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['crypto.tenant_key.created', 'crypto.tenant_key.destroyed']);
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toMatch(/vault:v\d|wrapped|"dek"/i);
    expect(await verifyPlatformAuditChain(platform)).toMatchObject({ ok: true });
  });
});
