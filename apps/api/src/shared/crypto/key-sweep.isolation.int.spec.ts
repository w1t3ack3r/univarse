/**
 * Spec 0014 (cross-tenant suite, layer 4): the key sweep processes only the tenant whose request it claimed.
 * Prereqs: `pnpm dev:infra` (Vault configured), `pnpm db:migrate && pnpm db:seed`.
 * Scratch tenants only (OFFBOARDING: no resolver, no outbox delivery); the seeded tenants' keys are never rotated.
 *
 * The tenant-context spy wraps the worker's own ShardRegistry (tx and forTenant), passing calls through and
 * recording each call's tenant id. Every pass is checked on its own: whatever request a pass claims (other
 * suites' leftovers included), every tenant-context call in that pass must name that request's tenant.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FieldCrypto,
  keyProviderFrom,
  provisionTenantKey,
  rotateTenantKey,
  TenantKeyring,
  legacyKeyringFromEnv,
  type KeyProvider,
} from '@univarse/crypto';
import {
  createTenantShardClient,
  forTenant,
  withTenantTx,
  type PlatformClient,
  type TenantShardClient,
} from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../config/config.js';
import { mfaSecretAad } from '../../modules/identity/mfa.service.js';
import { WorkerModule } from '../../worker.module.js';
import { PLATFORM_DB, ShardRegistry } from '../db/db.module.js';
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
/** Tenant ids of every tenant-context call the worker made, in order. */
const calls: string[] = [];

beforeAll(async () => {
  config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
  platform = ctx.get<PlatformClient>(PLATFORM_DB);
  keys = ctx.get(KeyMaintenance);
  fieldCrypto = ctx.get(FieldCrypto);
  provider = keyProviderFrom(config);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
  shardId = (await platform.shard.findFirstOrThrow({ where: { isActive: true } })).id;
  // The spy: the worker's own registry, wrapped so every tenant-context call is recorded and passed through.
  const registry = ctx.get(ShardRegistry);
  const tx = registry.tx.bind(registry);
  const ft = registry.forTenant.bind(registry);
  registry.tx = (s: string, t: string, fn: never, o?: never) => (calls.push(t), tx(s, t, fn, o));
  registry.forTenant = (s: string, t: string) => (calls.push(t), ft(s, t));
});

afterAll(async () => {
  await shard.$disconnect();
  await ctx.close();
});

interface Scratch {
  readonly id: string;
  readonly ref: { id: string; shardId: string };
  readonly values: {
    table: 'mfa_factor' | 'outbox_event';
    id: string;
    aad: string;
    plaintext: string;
  }[];
}

async function scratch(label: string, outbox = 3): Promise<Scratch> {
  const t = await platform.tenant.create({
    data: {
      slug: `iso-${label}-${run}`,
      legalName: `Isolation ${label}`,
      shortName: `ISO-${label}`.toUpperCase(),
      type: 'UNIVERSITY',
      ownership: 'PRIVATE',
      status: 'OFFBOARDING',
      shardId,
    },
  });
  await provisionTenantKey(platform, provider, t.id);
  const db = forTenant(shard, t.id);
  const user = await db.userAccount.create({
    data: {
      tenantId: t.id,
      username: `I${run}${label}`.toUpperCase(),
      displayName: 'Isolation',
      status: 'ACTIVE',
    },
  });
  const values: Scratch['values'] = [];
  const totp = `totp-${label}-${run}`;
  const factor = await db.mfaFactor.create({
    data: {
      tenantId: t.id,
      userId: user.id,
      type: 'TOTP',
      secretEnc: await fieldCrypto.encrypt(t.id, Buffer.from(totp), mfaSecretAad(t.id, user.id)),
      confirmedAt: new Date(),
    },
  });
  values.push({
    table: 'mfa_factor',
    id: factor.id,
    aad: mfaSecretAad(t.id, user.id),
    plaintext: totp,
  });
  for (let i = 0; i < outbox; i++) {
    const id = randomUUID();
    const body = `mail-${label}-${String(i)}`;
    await db.outboxEvent.create({
      data: {
        id,
        tenantId: t.id,
        type: 'email',
        payloadEnc: await fieldCrypto.encrypt(t.id, Buffer.from(body), outboxAad(t.id, id)),
      },
    });
    values.push({ table: 'outbox_event', id, aad: outboxAad(t.id, id), plaintext: body });
  }
  return { id: t.id, ref: { id: t.id, shardId }, values };
}

async function stored(s: Scratch): Promise<string[]> {
  const db = forTenant(shard, s.id);
  const out: string[] = [];
  for (const v of s.values) {
    out.push(
      v.table === 'mfa_factor'
        ? (await db.mfaFactor.findUniqueOrThrow({ where: { id: v.id } })).secretEnc
        : ((await db.outboxEvent.findUniqueOrThrow({ where: { id: v.id } })).payloadEnc ?? ''),
    );
  }
  return out;
}

/** Every value decrypts to what was sealed, under its own tenant, through a keyring that has cached nothing. */
async function expectReadable(s: Scratch): Promise<void> {
  const fresh = new FieldCrypto(
    new TenantKeyring(platform, provider),
    legacyKeyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY),
  );
  const now = await stored(s);
  for (const [i, v] of s.values.entries())
    expect((await fresh.decrypt(s.id, now[i]!, v.aad)).toString()).toBe(v.plaintext);
}

/** Hold a tenant's request as if another worker had leased it: pending, but not claimable now. */
const hold = (tenantId: string) =>
  platform.keyReencryption.update({
    where: { tenantId },
    data: { leaseUntil: new Date(Date.now() + 60 * 60_000) },
  });
const release = (tenantId: string) =>
  platform.keyReencryption.update({ where: { tenantId }, data: { leaseUntil: null } });

/**
 * Runs passes until `tenantId`'s request completes. For EVERY pass: the spy saw only the claimed tenant.
 * Returns the passes' claimed tenant ids.
 */
async function sweepUntilDone(tenantId: string): Promise<string[]> {
  const claimedBy: string[] = [];
  for (let i = 0; i < 50; i++) {
    if ((await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId } })).completedAt)
      return claimedBy;
    calls.length = 0;
    const out = await keys.runOnce();
    if (!out) continue;
    claimedBy.push(out.tenantId);
    expect(calls.length, 'the pass made tenant-context calls').toBeGreaterThan(0);
    expect(new Set(calls), `every tenant-context call of the pass for ${out.tenantId}`).toEqual(
      new Set([out.tenantId]),
    );
  }
  throw new Error('sweep did not complete');
}

describe('[JI5] the key sweep claims and processes only the requested tenant', () => {
  it('[JI5][JI8] with both keys rotated but only A requested, A moves entirely and B is byte-for-byte unchanged', async () => {
    const a = await scratch('a');
    const b = await scratch('b');
    expect(await rotateTenantKey(platform, provider, a.id, null)).toEqual({ from: 1, to: 2 });
    expect(await rotateTenantKey(platform, provider, b.id, null)).toEqual({ from: 1, to: 2 });
    await hold(b.id);
    const bBefore = await stored(b);

    const passes = await sweepUntilDone(a.id);
    expect(passes).toContain(a.id);
    expect(passes).not.toContain(b.id);
    for (const v of await stored(a)) expect(v).toMatch(/^v2:2:/);
    expect(await stored(b), "B's ciphertexts").toEqual(bBefore);
    for (const v of bBefore) expect(v).toMatch(/^v2:1:/);
    expect(await keys.usage(b.ref)).toEqual({ '1': b.values.length });
    await expectReadable(a);
    await expectReadable(b);

    // Only once B's own request is claimable is B swept, by a pass for B.
    await release(b.id);
    expect(await sweepUntilDone(b.id)).toContain(b.id);
    for (const v of await stored(b)) expect(v).toMatch(/^v2:2:/);
    await expectReadable(b);
  });
});

describe('[JI6] one request, one tenant', () => {
  it('[JI6][JI8] with both pending, each pass does exactly its own request’s work, and everything still decrypts', async () => {
    const a = await scratch('c', 2);
    const b = await scratch('d', 2);
    await rotateTenantKey(platform, provider, a.id, null);
    await rotateTenantKey(platform, provider, b.id, null);
    const before = { a: await stored(a), b: await stored(b) };

    // Each pass: the spy names only its claimed tenant (checked inside), and the values it changed are all that tenant's.
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const otherBefore = await stored(other);
      const otherDone = (
        await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: other.id } })
      ).completedAt;
      if (!otherDone) await hold(other.id);
      await sweepUntilDone(mine.id);
      expect(await stored(other), `${other.id} untouched by ${mine.id}'s sweep`).toEqual(
        otherBefore,
      );
      if (!otherDone) await release(other.id);
    }
    expect(await stored(a)).not.toEqual(before.a);
    expect(await stored(b)).not.toEqual(before.b);
    for (const s of [a, b]) {
      expect(await keys.usage(s.ref)).toEqual({ '2': s.values.length });
      expect(
        (await platform.keyReencryption.findUniqueOrThrow({ where: { tenantId: s.id } }))
          .completedAt,
      ).toBeInstanceOf(Date);
      await expectReadable(s);
    }
  });
});

describe('[JI7] RLS is the backstop for the sweep’s column operations', () => {
  it("[JI7][JI8] for every registered column: under A's context lockStale and swap with B's id reach none of B's rows; under B's context they reach its fixture", async () => {
    const a = await scratch('e', 1);
    const b = await scratch('f', 1);
    const bBefore = await stored(b);
    const NIL = '00000000-0000-0000-0000-000000000000';
    for (const col of ENCRYPTED_COLUMNS) {
      // Every registered table.column needs a fixture in B; a missing one fails here (never a silent zero).
      const i = b.values.findIndex((v) => v.table === col.table);
      expect(
        i,
        `a fixture for ${col.table}.${col.column} in the scratch tenant`,
      ).toBeGreaterThanOrEqual(0);
      const fixture = b.values[i]!;
      const old = bBefore[i]!;

      // The mutant call: B's id inside A's database context. RLS hides every one of B's rows.
      const asA = await withTenantTx(shard, a.id, async (tx) => {
        const locked = await col.lockStale(tx, b.id, 'v9:none:%', NIL, 100);
        const swapped = await col.swap(tx, b.id, fixture.id, old, 'v2:999:tampered');
        return {
          bRowsLocked: locked.filter((r) => r.id === fixture.id || bBefore.includes(r.value))
            .length,
          swapped,
        };
      });
      expect(asA, `${col.table}.${col.column} under A's context`).toEqual({
        bRowsLocked: 0,
        swapped: 0,
      });

      // The control: the same operations in B's own context reach B's fixture. swap(old, old) changes one row and
      // leaves the ciphertext as it was.
      const asB = await withTenantTx(shard, b.id, async (tx) => {
        const locked = await col.lockStale(tx, b.id, 'v9:none:%', NIL, 100);
        const swapped = await col.swap(tx, b.id, fixture.id, old, old);
        return {
          fixtureLocked: locked.some((r) => r.id === fixture.id && r.value === old),
          swapped,
        };
      });
      expect(asB, `${col.table}.${col.column} under B's own context`).toEqual({
        fixtureLocked: true,
        swapped: 1,
      });
    }
    expect(await stored(b), "B's values unchanged").toEqual(bBefore);
    await expectReadable(b);
  });
});
