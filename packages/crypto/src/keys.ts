// Tenant DEK lifecycle (spec 0006 E1, E2, E10, E11, E12). Platform-side only: never reachable from a
// tenant endpoint. Every change is audited in the same platform transaction.
import { randomBytes } from 'node:crypto';
import type { PlatformClient } from '@univarse/db';
import { writePlatformAudit } from './platform-audit.js';
import { KeyUnavailableError, vaultKeyVersionOf, wrapContext, type KeyProvider, type VaultKeyAdmin } from './providers.js';

/**
 * E11: gives a tenant its first (or next, when it has none active) DEK. Idempotent: a tenant that
 * already has an ACTIVE key is left untouched and its version is returned.
 */
export async function provisionTenantKey(
  platform: PlatformClient,
  provider: KeyProvider,
  tenantId: string,
  actorId: string | null = null,
): Promise<{ version: number; created: boolean }> {
  const active = await platform.tenantDataKey.findFirst({ where: { tenantId, status: 'ACTIVE' } });
  if (active) return { version: active.version, created: false };

  const latest = await platform.tenantDataKey.findFirst({ where: { tenantId }, orderBy: { version: 'desc' } });
  const version = (latest?.version ?? 0) + 1;
  const dek = randomBytes(32);
  try {
    // Wrap outside the DB transaction (a network call); the row and its audit commit together.
    const wrapped = await provider.wrap(dek, wrapContext(tenantId, version));
    await platform.$transaction(async (tx) => {
      await tx.tenantDataKey.create({ data: { tenantId, version, kekId: provider.kekId, wrappedDek: wrapped } });
      await writePlatformAudit(tx, {
        actorId,
        action: 'crypto.tenant_key.created',
        tenantId,
        metadata: { version, kekId: provider.kekId },
      });
    });
    return { version, created: true };
  } finally {
    dek.fill(0);
  }
}

/**
 * E10 crypto-shredding: erases every wrapped DEK of the tenant. All of its encrypted fields become
 * permanently undecryptable; other tenants are unaffected. Irreversible by design.
 */
export async function destroyTenantKeys(
  platform: PlatformClient,
  tenantId: string,
  actorId: string | null,
  reason: string,
): Promise<number> {
  return platform.$transaction(async (tx) => {
    const live = await tx.tenantDataKey.findMany({ where: { tenantId, status: { not: 'DESTROYED' } }, select: { version: true } });
    if (live.length === 0) return 0;
    await tx.tenantDataKey.updateMany({
      where: { tenantId, status: { not: 'DESTROYED' } },
      data: { status: 'DESTROYED', wrappedDek: null, destroyedAt: new Date() },
    });
    await writePlatformAudit(tx, {
      actorId,
      action: 'crypto.tenant_key.destroyed',
      tenantId,
      metadata: { versions: live.map((k) => k.version).sort((a, b) => a - b), reason },
    });
    return live.length;
  });
}

/** Asks the worker to bring every encrypted value of the tenant onto its active version (E7, E9). */
export async function requestReencryption(
  tx: Pick<PlatformClient, 'keyReencryption'>,
  tenantId: string,
  reason: 'ROTATION' | 'LEGACY_V1',
): Promise<void> {
  const now = new Date();
  await tx.keyReencryption.upsert({
    where: { tenantId },
    create: { tenantId, reason, requestedAt: now },
    update: { reason, requestedAt: now, completedAt: null },
  });
}

/**
 * E7: retires the active DEK and makes a new version active, in one platform transaction with its
 * audit event and a sweep request. The old version keeps decrypting until it is destroyed.
 */
export async function rotateTenantKey(
  platform: PlatformClient,
  provider: KeyProvider,
  tenantId: string,
  actorId: string | null,
): Promise<{ from: number; to: number }> {
  const current = await platform.tenantDataKey.findFirst({ where: { tenantId, status: 'ACTIVE' } });
  if (!current) throw new KeyUnavailableError('no_active_key');
  const latest = await platform.tenantDataKey.findFirst({ where: { tenantId }, orderBy: { version: 'desc' } });
  const to = (latest?.version ?? current.version) + 1;
  const dek = randomBytes(32);
  try {
    const wrapped = await provider.wrap(dek, wrapContext(tenantId, to));
    await platform.$transaction(async (tx) => {
      // Lock the active row: a concurrent rotation waits here, then finds it RETIRED and fails.
      const locked = await tx.$queryRaw<{ version: number }[]>`
        SELECT version FROM tenant_data_key WHERE tenant_id = ${tenantId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
      if (locked[0]?.version !== current.version) throw new Error('Concurrent key rotation; retry');
      await tx.tenantDataKey.update({
        where: { tenantId_version: { tenantId, version: current.version } },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      await tx.tenantDataKey.create({ data: { tenantId, version: to, kekId: provider.kekId, wrappedDek: wrapped } });
      await requestReencryption(tx, tenantId, 'ROTATION');
      await writePlatformAudit(tx, {
        actorId,
        action: 'crypto.tenant_key.rotated',
        tenantId,
        metadata: { from: current.version, to, kekId: provider.kekId },
      });
    });
    return { from: current.version, to };
  } finally {
    dek.fill(0);
  }
}

export class RetiredKeyInUseError extends Error {
  constructor(readonly why: 'not_retired' | 'grace_period' | 'values_remain', readonly remaining = 0) {
    super(`Retired key cannot be destroyed yet (${why}${remaining ? `: ${remaining} values` : ''})`);
    this.name = 'RetiredKeyInUseError';
  }
}

/** Longer than the keyring TTL and any request that read the old active version before rotation. */
export const RETIRED_KEY_GRACE_MS = 60 * 60_000;

/**
 * E7: destroys one RETIRED version, only once nothing uses it. `countValues` scans the tenant's
 * encrypted columns for values on that version (it needs the shards, so the caller supplies it).
 */
export async function destroyRetiredKey(
  platform: PlatformClient,
  tenantId: string,
  version: number,
  countValues: (version: number) => Promise<number>,
  opts: { actorId: string | null; reason: string; graceMs?: number; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  const row = await platform.tenantDataKey.findUnique({ where: { tenantId_version: { tenantId, version } } });
  if (row?.status !== 'RETIRED' || !row.retiredAt) throw new RetiredKeyInUseError('not_retired');
  if (now() - row.retiredAt.getTime() < (opts.graceMs ?? RETIRED_KEY_GRACE_MS)) throw new RetiredKeyInUseError('grace_period');
  const remaining = await countValues(version);
  if (remaining > 0) throw new RetiredKeyInUseError('values_remain', remaining);
  await platform.$transaction(async (tx) => {
    const n = await tx.tenantDataKey.updateMany({
      where: { tenantId, version, status: 'RETIRED' },
      data: { status: 'DESTROYED', wrappedDek: null, destroyedAt: new Date() },
    });
    if (n.count !== 1) throw new RetiredKeyInUseError('not_retired');
    await writePlatformAudit(tx, {
      actorId: opts.actorId,
      action: 'crypto.tenant_key.destroyed',
      tenantId,
      metadata: { versions: [version], reason: opts.reason },
    });
  });
}

/**
 * E8: after the Transit key is rotated, re-wraps every live DEK made with an older Transit key
 * version. Each row is updated only if its wrap is unchanged (compare-and-swap). DEKs never leave
 * Vault in plaintext. One audit event records the run, including a partial one.
 *
 * A wrap Vault refuses (wrong context, tampered) is skipped and reported in `failed`, so one bad row
 * can't block every other tenant's re-wrap. Vault being unavailable stops the run (rethrown).
 */
export async function rewrapAllDeks(
  platform: PlatformClient,
  admin: VaultKeyAdmin,
  actorId: string | null,
): Promise<{ keyVersion: number; rewrapped: number; failed: { tenantId: string; version: number }[] }> {
  const keyVersion = await admin.latestKeyVersion();
  const live = await platform.tenantDataKey.findMany({
    where: { status: { not: 'DESTROYED' }, kekId: admin.kekId },
    select: { tenantId: true, version: true, wrappedDek: true },
  });
  let rewrapped = 0;
  const failed: { tenantId: string; version: number }[] = [];
  const audit = (aborted: boolean) =>
    platform.$transaction(async (tx) => {
      await writePlatformAudit(tx, {
        actorId,
        action: 'crypto.kek.rewrapped',
        tenantId: null,
        metadata: { kekId: admin.kekId, keyVersion, count: rewrapped, failed: failed.length, aborted },
      });
    });
  try {
    for (const k of live) {
      if (!k.wrappedDek || (vaultKeyVersionOf(k.wrappedDek) ?? keyVersion) >= keyVersion) continue;
      let next: string;
      try {
        next = await admin.rewrap(k.wrappedDek, wrapContext(k.tenantId, k.version));
      } catch (err) {
        if (!(err instanceof KeyUnavailableError) || err.reason !== 'unwrap_failed') throw err;
        failed.push({ tenantId: k.tenantId, version: k.version });
        continue;
      }
      const n = await platform.tenantDataKey.updateMany({
        where: { tenantId: k.tenantId, version: k.version, wrappedDek: k.wrappedDek },
        data: { wrappedDek: next },
      });
      rewrapped += n.count;
    }
  } catch (err) {
    await audit(true);
    throw err;
  }
  await audit(false);
  return { keyVersion, rewrapped, failed };
}
