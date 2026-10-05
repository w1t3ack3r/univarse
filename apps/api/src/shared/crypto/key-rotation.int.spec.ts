/**
 * Spec 0006 PR B — DEK rotation and the sweep (E7), KEK re-wrap (E8), v1 → v2 migration (E9).
 * Prereqs: `pnpm dev:infra` (Vault configured, VAULT_ADMIN_TOKEN in .env), `pnpm db:migrate && pnpm db:seed`.
 * Every test uses scratch tenants (OFFBOARDING: no resolver, no outbox delivery), never the seeded ones.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  destroyRetiredKey,
  destroyTenantKeys,
  encryptV1ForTests,
  FieldCrypto,
  keyProviderFrom,
  legacyKeyringFromEnv,
  provisionTenantKey,
  requestReencryption,
  RetiredKeyInUseError,
  rewrapAllDeks,
  rotateTenantKey,
  TenantKeyring,
  vaultKeyVersionOf,
  VaultKeyAdmin,
  wrapContext,
  type KeyProvider,
} from '@univarse/crypto';
import { createTenantShardClient, forTenant, withTenantTx, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../config/config.js';
import { mfaSecretAad } from '../../modules/identity/mfa.service.js';
import { WorkerModule } from '../../worker.module.js';
import { PLATFORM_DB } from '../db/db.module.js';
import { outboxAad } from '../outbox/outbox.js';
import { ENCRYPTED_COLUMNS } from './encrypted-columns.js';
import { KeyMaintenance } from './key-maintenance.js';

let ctx: INestApplicationContext;
let config: AppConfig;
let platform: PlatformClient;
let shard: TenantShardClient;
let keys: KeyMaintenance;
let fieldCrypto: FieldCrypto;
let provider: KeyProvider;
let shardId: string;
const run = randomBytes(3).toString('hex');
const HOUR = 60 * 60_000;

beforeAll(async () => {
  config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
  platform = ctx.get<PlatformClient>(PLATFORM_DB);
  keys = ctx.get(KeyMaintenance);
  fieldCrypto = ctx.get(FieldCrypto);
  provider = keyProviderFrom(config);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
  shardId = (await platform.shard.findFirstOrThrow({ where: { isActive: true } })).id;
});
afterAll(async () => {
  await shard.$disconnect();
  await ctx.close();
});

interface Scratch {
  readonly id: string;
  readonly ref: { id: string; shardId: string };
  /** Encrypted values the scratch tenant holds, with what they decrypt to. */
  readonly values: { table: 'mfa_factor' | 'outbox_event'; id: string; aad: string; plaintext: string }[];
}

/** A throwaway tenant with a data key, one user with a TOTP secret, and `outbox` pending payloads. */
async function scratch(label: string, opts: { outbox?: number; legacy?: boolean } = {}): Promise<Scratch> {
  const t = await platform.tenant.create({
    data: {
      slug: `key-${label}-${run}`,
      legalName: `Key Test ${label}`,
      shortName: `KEY-${label}`.toUpperCase(),
      type: 'UNIVERSITY',
      ownership: 'PRIVATE',
      status: 'OFFBOARDING',
      shardId,
    },
  });
  await provisionTenantKey(platform, provider, t.id);
  const legacy = legacyKeyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY);
  const seal = async (pt: string, aad: string) =>
    opts.legacy ? encryptV1ForTests(legacy, config.DATA_ENCRYPTION_KEY_ID!, Buffer.from(pt), aad) : fieldCrypto.encrypt(t.id, Buffer.from(pt), aad);

  const values: Scratch['values'] = [];
  const db = forTenant(shard, t.id);
  const user = await db.userAccount.create({ data: { tenantId: t.id, username: `K${run}${label}`.toUpperCase(), displayName: 'Key Test', status: 'ACTIVE' } });
  const totp = `totp-${label}`;
  const factor = await db.mfaFactor.create({
    data: { tenantId: t.id, userId: user.id, type: 'TOTP', secretEnc: await seal(totp, mfaSecretAad(t.id, user.id)), confirmedAt: new Date() },
  });
  values.push({ table: 'mfa_factor', id: factor.id, aad: mfaSecretAad(t.id, user.id), plaintext: totp });
  for (let i = 0; i < (opts.outbox ?? 2); i++) {
    const id = randomUUID();
    const body = `mail-${label}-${String(i)}`;
    await db.outboxEvent.create({ data: { id, tenantId: t.id, type: 'email', payloadEnc: await seal(body, outboxAad(t.id, id)) } });
    values.push({ table: 'outbox_event', id, aad: outboxAad(t.id, id), plaintext: body });
  }
  return { id: t.id, ref: { id: t.id, shardId }, values };
}

async function stored(s: Scratch, v: Scratch['values'][number]): Promise<string> {
  const db = forTenant(shard, s.id);
  return v.table === 'mfa_factor'
    ? (await db.mfaFactor.findUniqueOrThrow({ where: { id: v.id } })).secretEnc
    : ((await db.outboxEvent.findUniqueOrThrow({ where: { id: v.id } })).payloadEnc ?? '');
}

/** Every value still decrypts to what was sealed, through a keyring that has cached nothing. */
async function expectAllReadable(s: Scratch): Promise<void> {
  const fresh = new FieldCrypto(new TenantKeyring(platform, provider), legacyKeyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY));
  for (const v of s.values) expect((await fresh.decrypt(s.id, await stored(s, v), v.aad)).toString()).toBe(v.plaintext);
}

const backdateRetired = (tenantId: string, version: number, ms: number) =>
  platform.tenantDataKey.update({ where: { tenantId_version: { tenantId, version } }, data: { retiredAt: new Date(Date.now() - ms) } });

/** Runs claimed sweeps until this tenant's request is completed (other tests' requests may be ahead). */
async function sweepUntilDone(tenantId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const req = await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId } });
    if (req.completedAt) return;
    await keys.runOnce();
  }
  throw new Error('sweep did not complete');
}

describe('[E7] tenant DEK rotation', () => {
  it('[E7] rotating makes a new active version, retires the old one, audits, and requests a sweep', async () => {
    const s = await scratch('rot');
    expect(await rotateTenantKey(platform, provider, s.id, null)).toEqual({ from: 1, to: 2 });
    const rows = await platform.tenantDataKey.findMany({ where: { tenantId: s.id }, orderBy: { version: 'asc' } });
    expect(rows.map((k) => [k.version, k.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
    expect(rows[0]!.retiredAt).toBeInstanceOf(Date);
    expect(await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } })).toMatchObject({ reason: 'ROTATION', completedAt: null });
    const audit = await platform.platformAuditEvent.findFirstOrThrow({ where: { tenantId: s.id, action: 'crypto.tenant_key.rotated' } });
    expect(audit.metadata).toMatchObject({ from: 1, to: 2 });

    // New writes use v2 at once (no restart); old values stay readable before any sweep.
    expect(await fieldCrypto.encrypt(s.id, Buffer.from('new'), `${s.id}:x`)).toMatch(/^v2:2:/);
    for (const v of s.values) expect(await stored(s, v)).toMatch(/^v2:1:/);
    await expectAllReadable(s);
  });

  it('[E7] the sweep moves every encrypted value to the active version and completes the request', async () => {
    const s = await scratch('sweep', { outbox: 3 });
    await rotateTenantKey(platform, provider, s.id, null);
    await sweepUntilDone(s.id);
    for (const v of s.values) expect(await stored(s, v)).toMatch(/^v2:2:/);
    await expectAllReadable(s);
    expect(await keys.usage(s.ref)).toEqual({ '2': 4 });
    const req = await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } });
    expect(req.rowsReencrypted).toBe(4n);
    expect(await keys.sweepTenant(s.ref)).toEqual({ reencrypted: 0, unreadable: 0 }); // idempotent
  });

  it('[E7] a sweep stopped part-way resumes where it left off (the work query is the cursor)', async () => {
    const s = await scratch('resume', { outbox: 150 });
    await rotateTenantKey(platform, provider, s.id, null);
    // Batch 1: mfa_factor (1 row). Batch 2: the first 100 outbox payloads. Then "crash".
    expect(await keys.sweepTenant(s.ref, { maxBatches: 2 })).toEqual({ reencrypted: 101, unreadable: 0 });
    expect(await keys.usage(s.ref)).toEqual({ '1': 50, '2': 101 });
    expect(await keys.sweepTenant(s.ref)).toEqual({ reencrypted: 50, unreadable: 0 });
    expect(await keys.usage(s.ref)).toEqual({ '2': 151 });
    await expectAllReadable(s);
  });

  it('[E7] the sweep never overwrites a value the app changed meanwhile (compare-and-swap)', async () => {
    const s = await scratch('cas');
    const col = ENCRYPTED_COLUMNS.find((c) => c.table === 'mfa_factor')!;
    const v = s.values[0]!;
    const before = await stored(s, v);
    const changedByApp = await fieldCrypto.encrypt(s.id, Buffer.from('rotated-by-user'), v.aad);
    await forTenant(shard, s.id).mfaFactor.update({ where: { id: v.id }, data: { secretEnc: changedByApp } });
    // The sweep read `before`; its swap must not land on the app's newer value.
    const n = await withTenantTx(shard, s.id, (tx) => col.swap(tx, s.id, v.id, before, 'v2:9:stale:stale:stale'));
    expect(n).toBe(0);
    expect(await stored(s, v)).toBe(changedByApp);
  });

  it('[E7] two truly concurrent rotations: exactly one wins, and the tenant keeps exactly one active key', async () => {
    const s = await scratch('race');
    // Hold both rotations at the wrap step until both have read the current key, so they really race.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const gated: KeyProvider = {
      kekId: provider.kekId,
      unwrap: (w, c) => provider.unwrap(w, c),
      async wrap(dek, c) {
        if (++arrived === 2) release();
        await bothRead;
        return provider.wrap(dek, c);
      },
    };
    const results = await Promise.allSettled([rotateTenantKey(platform, gated, s.id, null), rotateTenantKey(platform, gated, s.id, null)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    // The loser fails on the row-lock check with a clean error (the unique version index is the backstop).
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(String(loser.reason)).toMatch(/Concurrent key rotation/);
    const rows = await platform.tenantDataKey.findMany({ where: { tenantId: s.id }, orderBy: { version: 'asc' } });
    expect(rows.map((k) => [k.version, k.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
    expect(await platform.platformAuditEvent.count({ where: { tenantId: s.id, action: 'crypto.tenant_key.rotated' } })).toBe(1);
    await expectAllReadable(s);
  });

  it('[E7] a retired version is destroyed only after the grace period and once no value uses it', async () => {
    const s = await scratch('destroy');
    const count = async (v: number) => (await keys.usage(s.ref))[String(v)] ?? 0;
    const destroy = (version: number) => destroyRetiredKey(platform, s.id, version, count, { actorId: null, reason: 'test' });

    await expect(destroy(1)).rejects.toMatchObject({ why: 'not_retired' }); // still ACTIVE
    await rotateTenantKey(platform, provider, s.id, null);
    await expect(destroy(1)).rejects.toMatchObject({ why: 'grace_period' });
    await backdateRetired(s.id, 1, HOUR + 1_000);
    await expect(destroy(1)).rejects.toMatchObject({ why: 'values_remain', remaining: 3 });
    expect(await platform.tenantDataKey.findUniqueOrThrow({ where: { tenantId_version: { tenantId: s.id, version: 1 } } })).toMatchObject({ status: 'RETIRED' });

    await keys.sweepTenant(s.ref);
    await destroy(1);
    expect(await platform.tenantDataKey.findUniqueOrThrow({ where: { tenantId_version: { tenantId: s.id, version: 1 } } })).toMatchObject({
      status: 'DESTROYED',
      wrappedDek: null,
    });
    await expectAllReadable(s); // nothing needed v1 any more
    const audit = await platform.platformAuditEvent.findFirstOrThrow({ where: { tenantId: s.id, action: 'crypto.tenant_key.destroyed' } });
    expect(audit.metadata).toMatchObject({ versions: [1] });
    await expect(destroy(2)).rejects.toBeInstanceOf(RetiredKeyInUseError); // the active key is never destroyable here
  });
});

describe('[E8] KEK re-wrap', () => {
  const adminToken = () => process.env.VAULT_ADMIN_TOKEN!;
  const admin = () => new VaultKeyAdmin({ addr: config.VAULT_ADDR!, token: adminToken(), mount: config.VAULT_TRANSIT_MOUNT, key: config.VAULT_TRANSIT_KEY });
  const transit = (path: string, token: string, body?: object) =>
    fetch(`${config.VAULT_ADDR!}/v1/${config.VAULT_TRANSIT_MOUNT}/${path}`, {
      method: 'POST',
      headers: { 'x-vault-token': token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('[E8] after the KEK rotates, every DEK is re-wrapped under the new KEK version; data is untouched and readable', async () => {
    const s = await scratch('kek');
    // A wrap that belongs to another tenant (as if copied): Vault refuses to rewrap it under this context.
    const bad = await scratch('kekbad');
    const sWrap = (await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: s.id } })).wrappedDek!;
    await platform.tenantDataKey.update({ where: { tenantId_version: { tenantId: bad.id, version: 1 } }, data: { wrappedDek: sWrap } });
    const before = await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: s.id, status: 'ACTIVE' } });
    const dekBefore = await provider.unwrap(before.wrappedDek!, wrapContext(s.id, before.version));
    const dataBefore = await Promise.all(s.values.map((v) => stored(s, v)));

    expect((await transit(`keys/${config.VAULT_TRANSIT_KEY}/rotate`, adminToken())).status).toBe(200);
    const latest = await admin().latestKeyVersion();
    // Old wraps still unwrap before the re-wrap runs (Transit keeps older key versions).
    expect((await provider.unwrap(before.wrappedDek!, wrapContext(s.id, before.version))).equals(dekBefore)).toBe(true);

    const r = await rewrapAllDeks(platform, admin(), null);
    expect(r.keyVersion).toBe(latest);
    expect(r.rewrapped).toBeGreaterThan(0);
    // The bad row is reported, not fatal: every other tenant was still re-wrapped.
    expect(r.failed).toContainEqual({ tenantId: bad.id, version: 1 });
    const after = await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: s.id, status: 'ACTIVE' } });
    expect(vaultKeyVersionOf(after.wrappedDek!)).toBe(latest);
    expect(after.wrappedDek).not.toBe(before.wrappedDek);
    expect((await provider.unwrap(after.wrappedDek!, wrapContext(s.id, after.version))).equals(dekBefore)).toBe(true); // same DEK
    expect(await Promise.all(s.values.map((v) => stored(s, v)))).toEqual(dataBefore); // tenant data not touched
    await expectAllReadable(s);

    // Nothing left to do: a second run re-wraps nothing. One audit event per run, no key material.
    expect((await rewrapAllDeks(platform, admin(), null)).rewrapped).toBe(0);
    const audits = await platform.platformAuditEvent.findMany({ where: { action: 'crypto.kek.rewrapped' }, orderBy: { seq: 'desc' }, take: 2 });
    expect(audits[1]!.metadata).toMatchObject({ keyVersion: latest, count: r.rewrapped, failed: r.failed.length, aborted: false });
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toMatch(/vault:v\d/);
    await destroyTenantKeys(platform, bad.id, null, 'test cleanup');
  });

  it('[E8] the app token can neither rewrap nor rotate the KEK', async () => {
    const s = await scratch('kek403');
    const row = await platform.tenantDataKey.findFirstOrThrow({ where: { tenantId: s.id } });
    const context = Buffer.from(wrapContext(s.id, row.version)).toString('base64');
    expect((await transit(`rewrap/${config.VAULT_TRANSIT_KEY}`, config.VAULT_TOKEN!, { ciphertext: row.wrappedDek, context })).status).toBe(403);
    expect((await transit(`keys/${config.VAULT_TRANSIT_KEY}/rotate`, config.VAULT_TOKEN!)).status).toBe(403);
  });
});

describe('[E9] v1 → v2 migration', () => {
  it('[E9] the sweep re-encrypts every v1 value to v2, keeps them readable, and audits completion', async () => {
    const s = await scratch('v1', { legacy: true, outbox: 2 });
    for (const v of s.values) expect(await stored(s, v)).toMatch(/^v1:/);
    expect(await keys.usage(s.ref)).toEqual({ v1: 3 });

    await requestReencryption(platform, s.id, 'LEGACY_V1');
    await sweepUntilDone(s.id);
    for (const v of s.values) expect(await stored(s, v)).toMatch(/^v2:1:/);
    expect(await keys.usage(s.ref)).toEqual({ '1': 3 });
    await expectAllReadable(s);
    const audit = await platform.platformAuditEvent.findFirstOrThrow({ where: { tenantId: s.id, action: 'crypto.legacy_v1.migrated' } });
    expect(audit.metadata).toMatchObject({ rowsReencrypted: 3 });

    // Idempotent: a second request finds nothing to do.
    await requestReencryption(platform, s.id, 'LEGACY_V1');
    await sweepUntilDone(s.id);
    expect(await keys.usage(s.ref)).toEqual({ '1': 3 });
  });

  it('[E9] an unreadable value is skipped and reported; every other value still migrates, and completion is not audited', async () => {
    const s = await scratch('v1bad', { legacy: true, outbox: 2 });
    const bad = s.values[1]!;
    await forTenant(shard, s.id).outboxEvent.update({ where: { id: bad.id }, data: { payloadEnc: 'v1:unknown-key:aaaa:bbbb:cccc' } });
    await requestReencryption(platform, s.id, 'LEGACY_V1');
    await sweepUntilDone(s.id);

    expect(await keys.usage(s.ref)).toEqual({ '1': 2, v1: 1 });
    expect(await stored(s, bad)).toBe('v1:unknown-key:aaaa:bbbb:cccc'); // left exactly as it was
    for (const v of s.values.filter((x) => x !== bad)) expect(await stored(s, v)).toMatch(/^v2:1:/);
    expect(await platform.platformAuditEvent.count({ where: { tenantId: s.id, action: 'crypto.legacy_v1.migrated' } })).toBe(0);
    // [E13] recorded as partial, not done.
    expect(await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } })).toMatchObject({ unreadableRemaining: 1n });
    expect(await keys.sweepTenant(s.ref)).toEqual({ reencrypted: 0, unreadable: 1 });
    // The app role can't delete outbox rows (append-only); clearing the payload is how it is resolved.
    await forTenant(shard, s.id).outboxEvent.update({ where: { id: bad.id }, data: { payloadEnc: null, status: 'DEAD' } });
  });

  it('[E13] a partial rotation sweep keeps the retired key until the unreadable value is resolved', async () => {
    const s = await scratch('partial', { outbox: 1 });
    const bad = s.values[1]!;
    // Corrupt one v1-key value (wrong AAD: a payload copied from the TOTP row), then rotate.
    await forTenant(shard, s.id).outboxEvent.update({ where: { id: bad.id }, data: { payloadEnc: await stored(s, s.values[0]!) } });
    await rotateTenantKey(platform, provider, s.id, null);
    await sweepUntilDone(s.id);
    expect(await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } })).toMatchObject({ unreadableRemaining: 1n });
    expect(await keys.usage(s.ref)).toEqual({ '1': 1, '2': 1 });

    await backdateRetired(s.id, 1, HOUR + 1_000);
    const count = async (v: number) => (await keys.usage(s.ref))[String(v)] ?? 0;
    const destroy = () => destroyRetiredKey(platform, s.id, 1, count, { actorId: null, reason: 'test' });
    await expect(destroy()).rejects.toMatchObject({ why: 'values_remain', remaining: 1 });

    // Resolved by the operator, then re-requested: the sweep is done and v1 can go.
    await forTenant(shard, s.id).outboxEvent.update({ where: { id: bad.id }, data: { payloadEnc: null, status: 'DEAD' } });
    await requestReencryption(platform, s.id, 'ROTATION');
    await sweepUntilDone(s.id);
    expect(await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } })).toMatchObject({ unreadableRemaining: 0n });
    await destroy();
  });

  it('[E9] more unreadable values than one batch never stall the sweep (it moves past them)', async () => {
    const s = await scratch('v1many', { legacy: true, outbox: 0 });
    const db = forTenant(shard, s.id);
    for (let i = 0; i < 120; i++) await db.outboxEvent.create({ data: { tenantId: s.id, type: 'email', payloadEnc: `v1:gone:${String(i)}:x:y` } });
    expect(await keys.sweepTenant(s.ref)).toEqual({ reencrypted: 1, unreadable: 120 }); // the TOTP secret still moved
    await db.outboxEvent.updateMany({ where: { tenantId: s.id }, data: { payloadEnc: null, status: 'DEAD' } });
  });
});

describe('encrypted-column registry', () => {
  it('every *_enc column in the tenant schema is registered for rotation and shredding', async () => {
    const cols = await shard.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name::text, column_name::text FROM information_schema.columns
      WHERE table_schema = 'public' AND right(column_name, 4) = '_enc' ORDER BY 1, 2`;
    const registered = ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort();
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual(registered);
    expect(registered.length).toBeGreaterThan(0);
  });
});
