// Tenant DEK lifecycle (spec 0006 E1, E2, E10, E11, E12). Platform-side only: never reachable from a
// tenant endpoint. Every change is audited in the same platform transaction.
import { randomBytes } from 'node:crypto';
import { TENANT_TX_TIMEOUT_MS, type PlatformClient } from '@univarse/db';
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
 * Spec 0020 D14: a destruction's operation id, given by the host protocol (D7) and recorded in `key_destruction` in
 * the destruction's own transaction. A second call with the same op is a no-op; one that disagrees with the record
 * (another tenant, kind or versions) is a conflict, never a second destruction.
 */
export interface DestructionOp {
  readonly op: string;
}

export class DestructionConflictError extends Error {
  constructor(readonly op: string, why: string) {
    super(`Destruction ${op} conflicts with its record: ${why}`);
    this.name = 'DestructionConflictError';
  }
}

type PlatformTx = Parameters<Parameters<PlatformClient['$transaction']>[0]>[0];

function sameVersions(a: readonly number[], b: readonly number[]): boolean {
  const x = [...a].sort((m, n) => m - n);
  const y = [...b].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** True when `op` was already recorded, exactly as asked: a repeat. Throws when the record says otherwise. */
async function recordedAlready(
  tx: Pick<PlatformTx, 'keyDestruction'>,
  op: string,
  expect: { tenantId: string; kind: 'TENANT' | 'RETIRED'; versions?: readonly number[] },
): Promise<boolean> {
  const prior = await tx.keyDestruction.findUnique({ where: { op } });
  if (!prior) return false;
  if (prior.tenantId !== expect.tenantId) throw new DestructionConflictError(op, 'another tenant');
  if (prior.kind !== expect.kind) throw new DestructionConflictError(op, `kind ${prior.kind}`);
  if (expect.versions && !sameVersions(prior.versions, expect.versions))
    throw new DestructionConflictError(op, `versions ${prior.versions.join(',')}`);
  return true;
}

/** Records the destruction, its audit event and the evidence row, in the destruction's transaction. */
async function recordDestruction(
  tx: PlatformTx,
  d: { op: string; tenantId: string; kind: 'TENANT' | 'RETIRED'; versions: number[]; actorId: string | null; reason: string; destroyedAt: Date },
): Promise<void> {
  const auditSeq = await writePlatformAudit(tx, {
    actorId: d.actorId,
    action: 'crypto.tenant_key.destroyed',
    tenantId: d.tenantId,
    metadata: { versions: d.versions, reason: d.reason, op: d.op },
  });
  await tx.keyDestruction.create({
    data: { op: d.op, tenantId: d.tenantId, kind: d.kind, versions: d.versions, reason: d.reason, destroyedAt: d.destroyedAt, auditSeq },
  });
}

/**
 * E10 crypto-shredding: erases every wrapped DEK of the tenant. All of its encrypted fields become
 * permanently undecryptable; other tenants are unaffected. Irreversible by design. Spec 0020 D14: the key rows are
 * locked and read inside the transaction, and the destruction is recorded under its `op`; returns how many versions
 * were destroyed now (0 for a repeat of the same `op`, or a tenant with none left).
 */
export async function destroyTenantKeys(
  platform: PlatformClient,
  tenantId: string,
  actorId: string | null,
  reason: string,
  { op }: DestructionOp,
): Promise<number> {
  return platform.$transaction(async (tx) => {
    if (await recordedAlready(tx, op, { tenantId, kind: 'TENANT' })) return 0;
    const rows = await tx.$queryRaw<{ version: number; status: string }[]>`
      SELECT version, status::text AS status FROM tenant_data_key WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const live = rows.filter((r) => r.status !== 'DESTROYED').map((r) => r.version).sort((a, b) => a - b);
    if (live.length === 0) return 0;
    const destroyedAt = new Date();
    await tx.tenantDataKey.updateMany({
      where: { tenantId, version: { in: live } },
      data: { status: 'DESTROYED', wrappedDek: null, destroyedAt },
    });
    await recordDestruction(tx, { op, tenantId, kind: 'TENANT', versions: live, actorId, reason, destroyedAt });
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
  constructor(readonly why: 'not_retired' | 'grace_period' | 'sweep_pending' | 'values_remain', readonly remaining = 0) {
    super(`Retired key cannot be destroyed yet (${why}${remaining ? `: ${remaining} values` : ''})`);
    this.name = 'RetiredKeyInUseError';
  }
}

/**
 * Spec 0020 D15's `G`: how long a version stays RETIRED before it may be destroyed. Longer than the keyring TTL and
 * far longer than the writer bound (`W`, the tenant transaction's timeout).
 */
export const RETIRED_KEY_GRACE_MS = 60 * 60_000;
/** D15: `G` is never below `W` plus this margin. */
export const GRACE_MARGIN_MS = 60_000;

/** D15: why this grace period is too short to rest on the writer bound, or null. */
export function graceProblem(graceMs: number, writerBoundMs = TENANT_TX_TIMEOUT_MS): string | null {
  return graceMs < writerBoundMs + GRACE_MARGIN_MS
    ? `the grace period (${String(graceMs)} ms) must be at least the writer bound (${String(writerBoundMs)} ms) plus ${String(GRACE_MARGIN_MS)} ms (spec 0020 D15)`
    : null;
}

/** What D15 decides on, as read from the platform DB. */
export interface RetiredKeyState {
  readonly status: string | null;
  readonly retiredAt: Date | null;
  readonly sweep: { readonly startedAt: Date | null; readonly completedAt: Date | null; readonly unreadableRemaining: bigint } | null;
}

/**
 * Spec 0020 D15: why this version may not be destroyed yet, or null when it may (values still carrying it are
 * counted separately). Eligible only when it has been RETIRED for at least `graceMs`, AND a sweep that STARTED after
 * `retiredAt + graceMs` has completed with no unreadable value. Every writer that could have read the version as
 * active has committed by then, so only such a sweep can have seen all of its values.
 */
export function retiredKeyProblem(s: RetiredKeyState, now: number, graceMs: number): 'not_retired' | 'grace_period' | 'sweep_pending' | null {
  if (s.status !== 'RETIRED' || !s.retiredAt) return 'not_retired';
  const eligibleFrom = s.retiredAt.getTime() + graceMs;
  if (now < eligibleFrom) return 'grace_period';
  const sw = s.sweep;
  if (!sw?.startedAt || !sw.completedAt) return 'sweep_pending';
  if (sw.startedAt.getTime() < eligibleFrom || sw.completedAt.getTime() < sw.startedAt.getTime() || sw.unreadableRemaining > 0n) return 'sweep_pending';
  return null;
}

/**
 * E7: destroys one RETIRED version, only once nothing uses it (spec 0020 D14, D15). `countValues` scans the tenant's
 * encrypted columns for values on that version (it needs the shards, so the caller supplies it).
 * 1. A read-only check (the protocol's precheck, before its `pending` record).
 * 2. In ONE platform transaction: the op's record checked (a repeat is a no-op); the key row and the sweep row
 *    locked and re-read; D15 decided again on what is now locked; the values counted again; then the destruction,
 *    its audit event and its `key_destruction` row. A precondition that no longer holds rolls it all back.
 * Returns true when it destroyed the version now, false for a repeat of the same op.
 */
export async function destroyRetiredKey(
  platform: PlatformClient,
  tenantId: string,
  version: number,
  countValues: (version: number) => Promise<number>,
  opts: DestructionOp & { actorId: string | null; reason: string; graceMs?: number; now?: () => number; afterPrecheck?: () => Promise<void> },
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? RETIRED_KEY_GRACE_MS;
  const short = graceProblem(graceMs);
  if (short) throw new Error(short);
  // A repeat of a committed op is answered from its record, whatever the key's state is now.
  if (await recordedAlready(platform, opts.op, { tenantId, kind: 'RETIRED', versions: [version] })) return false;
  await checkRetiredKey(platform, tenantId, version, countValues, { graceMs, now });
  await opts.afterPrecheck?.(); // tests only: the window between the read-only check and the transaction (BK14)
  return platform.$transaction(async (tx) => {
    if (await recordedAlready(tx, opts.op, { tenantId, kind: 'RETIRED', versions: [version] })) return false;
    const key = await tx.$queryRaw<{ status: string; retired_at: Date | null }[]>`
      SELECT status::text AS status, retired_at FROM tenant_data_key WHERE tenant_id = ${tenantId}::uuid AND version = ${version} FOR UPDATE`;
    const sweep = await tx.$queryRaw<{ started_at: Date | null; completed_at: Date | null; unreadable_remaining: bigint }[]>`
      SELECT started_at, completed_at, unreadable_remaining FROM key_reencryption WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
    const s = sweep[0];
    const why = retiredKeyProblem(
      { status: key[0]?.status ?? null, retiredAt: key[0]?.retired_at ?? null, sweep: s ? { startedAt: s.started_at, completedAt: s.completed_at, unreadableRemaining: s.unreadable_remaining } : null },
      now(),
      graceMs,
    );
    if (why) throw new RetiredKeyInUseError(why);
    // D15: no writer can commit under this version any more, so its count can only fall; counted again here.
    const remaining = await countValues(version);
    if (remaining > 0) throw new RetiredKeyInUseError('values_remain', remaining);
    const destroyedAt = new Date();
    await tx.tenantDataKey.update({
      where: { tenantId_version: { tenantId, version } },
      data: { status: 'DESTROYED', wrappedDek: null, destroyedAt },
    });
    await recordDestruction(tx, { op: opts.op, tenantId, kind: 'RETIRED', versions: [version], actorId: opts.actorId, reason: opts.reason, destroyedAt });
    return true;
  }, { timeout: RETIRED_DESTRUCTION_TX_TIMEOUT_MS });
}

/**
 * The retired-key destruction's transaction counts the tenant's values across every encrypted column, so it gets
 * longer than Prisma's 5 s default. Its locks hold back only that tenant's rotation and sweep completion.
 */
export const RETIRED_DESTRUCTION_TX_TIMEOUT_MS = 60_000;

/** The read-only check alone (the protocol's precheck): throws RetiredKeyInUseError, or returns when eligible now. */
export async function checkRetiredKey(
  platform: PlatformClient,
  tenantId: string,
  version: number,
  countValues: (version: number) => Promise<number>,
  opts: { graceMs?: number; now?: () => number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? RETIRED_KEY_GRACE_MS;
  const row = await platform.tenantDataKey.findUnique({ where: { tenantId_version: { tenantId, version } } });
  const sweep = await platform.keyReencryption.findUnique({ where: { tenantId } });
  const why = retiredKeyProblem({ status: row?.status ?? null, retiredAt: row?.retiredAt ?? null, sweep }, (opts.now ?? Date.now)(), graceMs);
  if (why) throw new RetiredKeyInUseError(why);
  const remaining = await countValues(version);
  if (remaining > 0) throw new RetiredKeyInUseError('values_remain', remaining);
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
