// Key sweep (spec 0006 E7, E9): brings every encrypted value of a tenant onto its active DEK version.
// Runs in the worker (claimed from key_reencryption under a lease) and from the `keys` CLI.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldCrypto, KeyUnavailableError, writePlatformAudit } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { PLATFORM_DB, ShardRegistry } from '../db/db.module.js';
import { errorSummary } from '../outbox/delivery-policy.js';
import { ENCRYPTED_COLUMNS, type EncryptedColumn } from './encrypted-columns.js';

const BATCH = 100;
const LEASE_MS = 10 * 60_000;

export interface TenantRef {
  readonly id: string;
  readonly shardId: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface SweepResult {
  reencrypted: number;
  /** Values left as they were because they can't be decrypted (see the warning logs). */
  unreadable: number;
}

/** Values per key version for one tenant (numbers only; `v1` = legacy). */
export type KeyUsage = Record<string, number>;

@Injectable()
export class KeyMaintenance {
  private readonly logger = new Logger('KeySweep');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly fieldCrypto: FieldCrypto,
  ) {}

  /**
   * Re-encrypts until nothing is left off the active version. Each batch is its own transaction:
   * rows are locked SKIP LOCKED and updated only if unchanged, so app writes always win. The active
   * version is read per batch, so a rotation mid-sweep is picked up. `maxBatches` stops early (tests
   * use it to prove a sweep resumes).
   *
   * A value that can't be decrypted (corrupted, or sealed with a key we no longer have) is left as
   * it is and counted in `unreadable`; one bad row must not block a tenant's migration. Vault being
   * unavailable is different: it aborts the sweep, which resumes later.
   */
  async sweepTenant(tenant: TenantRef, opts: { maxBatches?: number } = {}): Promise<SweepResult> {
    const result: SweepResult = { reencrypted: 0, unreadable: 0 };
    let batches = 0;
    for (const col of ENCRYPTED_COLUMNS) {
      let afterId = NIL_UUID;
      for (;;) {
        if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return result;
        const n = await this.sweepBatch(tenant, col, afterId);
        batches++;
        result.reencrypted += n.updated;
        result.unreadable += n.unreadable;
        if (n.lastId === null) break;
        afterId = n.lastId;
      }
    }
    return result;
  }

  private async sweepBatch(
    tenant: TenantRef,
    col: EncryptedColumn,
    afterId: string,
  ): Promise<{ updated: number; unreadable: number; lastId: string | null }> {
    const active = await this.fieldCrypto.activeVersion(tenant.id);
    return this.shards.tx(tenant.shardId, tenant.id, async (tx) => {
      const rows = await col.lockStale(tx, tenant.id, `v2:${String(active)}:%`, afterId, BATCH);
      let updated = 0;
      let unreadable = 0;
      for (const row of rows) {
        let next: string | null;
        try {
          next = await this.fieldCrypto.reencrypt(tenant.id, row.value, row.aad, active);
        } catch (err) {
          if (err instanceof KeyUnavailableError && err.reason === 'provider_unavailable') throw err;
          unreadable++;
          // Which row, never what it holds.
          this.logger.warn({ tenantId: tenant.id, table: col.table, id: row.id, error: errorSummary(err) }, 'Encrypted value unreadable; left as is');
          continue;
        }
        if (next !== null) updated += await col.swap(tx, tenant.id, row.id, row.value, next);
      }
      return { updated, unreadable, lastId: rows.length === BATCH ? (rows.at(-1)?.id ?? null) : null };
    });
  }

  /** E7/E9 status: how many values sit on each key version (and on v1). Never returns values. */
  async usage(tenant: TenantRef): Promise<KeyUsage> {
    const out: KeyUsage = {};
    for (const col of ENCRYPTED_COLUMNS) {
      const rows = await this.shards.tx(tenant.shardId, tenant.id, (tx) => col.count(tx, tenant.id));
      for (const r of rows) {
        const v = r.format === 'v1' ? 'v1' : r.version; // v1's second part is the legacy key id
        out[v] = (out[v] ?? 0) + r.n;
      }
    }
    return out;
  }

  /**
   * Claims one pending sweep request (lease + SKIP LOCKED), runs it, records the outcome. Returns
   * null when nothing was claimable. A failed sweep keeps its lease (10 min), which spaces retries.
   */
  async runOnce(): Promise<{ tenantId: string; ok: boolean; reencrypted: number; unreadable: number } | null> {
    const now = new Date();
    const claimed = await this.platform.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ tenant_id: string; requested_at: Date; reason: string }[]>`
        SELECT tenant_id::text, requested_at, reason::text FROM key_reencryption
        WHERE completed_at IS NULL AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const row = rows[0];
      if (!row) return null;
      await tx.keyReencryption.update({
        where: { tenantId: row.tenant_id },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now },
      });
      return row;
    });
    if (!claimed) return null;

    const tenant = await this.platform.tenant.findUniqueOrThrow({ where: { id: claimed.tenant_id }, select: { id: true, shardId: true } });
    try {
      const { reencrypted: n, unreadable } = await this.sweepTenant(tenant);
      const usage = await this.usage(tenant);
      await this.platform.$transaction(async (tx) => {
        // Completed only if nobody re-requested meanwhile; a rotation during the sweep runs it again.
        const done = await tx.keyReencryption.updateMany({
          where: { tenantId: tenant.id, requestedAt: claimed.requested_at },
          data: { completedAt: new Date(), leaseUntil: null, rowsReencrypted: { increment: n }, unreadableRemaining: unreadable },
        });
        if (done.count === 0) {
          await tx.keyReencryption.update({ where: { tenantId: tenant.id }, data: { leaseUntil: null, rowsReencrypted: { increment: n } } });
        } else if (claimed.reason === 'LEGACY_V1' && !usage.v1) {
          // E9 completion is audited only when no v1 value is left (unreadable ones included).
          await writePlatformAudit(tx, { actorId: null, action: 'crypto.legacy_v1.migrated', tenantId: tenant.id, metadata: { rowsReencrypted: n } });
        }
      });
      const log = { tenantId: tenant.id, reason: claimed.reason, rowsReencrypted: n, unreadable };
      if (unreadable > 0) this.logger.warn(log, 'Key sweep done; some values are unreadable and were left as is');
      else this.logger.log(log, 'Key sweep done');
      return { tenantId: tenant.id, ok: true, reencrypted: n, unreadable };
    } catch (err) {
      // The lease expires and a later pass starts again; values already moved are skipped by the query.
      this.logger.error({ tenantId: tenant.id, error: errorSummary(err) }, 'Key sweep failed');
      return { tenantId: tenant.id, ok: false, reencrypted: 0, unreadable: 0 };
    }
  }

  /** Polling loop for the worker process. Passes never overlap. */
  start(intervalMs: number): void {
    const tick = () => {
      this.running = this.runOnce()
        .catch((err: unknown) => this.logger.error({ error: errorSummary(err) }, 'Key sweep pass failed'))
        .finally(() => {
          if (this.timer !== null) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
