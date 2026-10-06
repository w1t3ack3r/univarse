import { withLogContext } from '../../shared/observability/context.js';
import { securityFields } from '../../shared/observability/security.js';
// Spec 0010: the scanning worker (FU3, FU4, FU7, FU13, FU15, FU16) and cleanup. Runs in the worker
// process beside the outbox and the key sweep, tenant by tenant under RLS.
//
// Every result is written conditionally on (state = SCANNING, the same lease token): a file deleted
// meanwhile, or re-claimed after this worker's lease lapsed, is never touched (deletion wins, FU15).
// Promotion writes the bytes that were scanned, from memory; the quarantine object is never copied.
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient, TenantTx } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { ClamdScanner, ScannerUnavailable } from './clamd-scanner.js';
import { contentProblem } from './file-types.js';
import { FileStorage } from './file-storage.js';
import { cleanKey } from './files.service.js';

export const SCAN_BATCH = 5;
export const LEASE_MS = 2 * 60_000;
/** Backoff before attempts 2, 3, 4; then SCAN_FAILED. Never clean (FU3). */
export const BACKOFF_MS = [10_000, 30_000, 120_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** A slot that was never completed is abandoned a minute after its URL expired (FU7). */
const ABANDON_GRACE_MS = 60_000;
const SERVABLE = ['ACTIVE', 'ONBOARDING'] as const;

interface Claimed {
  id: string;
  quarantine_key: string | null;
  mime: string;
  size_bytes: bigint;
  scan_attempts: number;
  lease_token: string;
}

export type ScanOutcome = 'clean' | 'infected' | 'rejected' | 'retry' | 'failed' | 'lost';

interface TenantRef {
  readonly id: string;
  readonly shardId: string;
}

@Injectable()
export class FileScanWorker {
  private readonly logger = new Logger('FileScan');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  /** Test hook (FU15, lease takeover): after the scan, before promotion and the result write. */
  beforeFinalize: ((fileId: string) => Promise<void>) | null = null;
  /** Test hook (lease takeover): after promotion, before the result write. */
  afterPromotion: ((fileId: string) => Promise<void>) | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly storage: FileStorage,
    private readonly scanner: ClamdScanner,
    private readonly audit: AuditWriter,
  ) {}

  async runOnce(): Promise<Record<ScanOutcome, number>> {
    const total: Record<ScanOutcome, number> = { clean: 0, infected: 0, rejected: 0, retry: 0, failed: 0, lost: 0 };
    const tenants = await this.platform.tenant.findMany({ where: { status: { in: [...SERVABLE] } }, select: { id: true, shardId: true } });
    for (const t of tenants) {
      try {
        // Spec 0012 OB2: lines from anything this tenant's pass calls carry its tenantId.
        await withLogContext({ tenantId: t.id }, async () => {
          await this.cleanup(t);
          for (const o of await this.scanTenant(t)) total[o]++;
        });
      } catch (err) {
        this.logger.error({ event: 'files.scan.tenant_failed', tenantId: t.id, error: (err as Error).name }, 'File scan pass failed for tenant');
      }
    }
    return total;
  }

  /** Claims due files (lease + SKIP LOCKED), scans each, writes each result conditionally. */
  async scanTenant(t: TenantRef): Promise<ScanOutcome[]> {
    const token = randomUUID();
    const claimed = await this.shards.tx(t.shardId, t.id, (tx) =>
      tx.$queryRaw<Claimed[]>`
        UPDATE file_object SET state = 'SCANNING', lease_token = ${token}::uuid,
          lease_until = now() + (${LEASE_MS} * interval '1 millisecond'), scan_attempts = scan_attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM file_object
          WHERE tenant_id = ${t.id}::uuid
            AND ((state = 'UPLOADED' AND (next_scan_at IS NULL OR next_scan_at <= now()))
              OR (state = 'SCANNING' AND lease_until < now()))
          ORDER BY next_scan_at NULLS FIRST, id
          LIMIT ${SCAN_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id::text, quarantine_key, mime, size_bytes, scan_attempts, lease_token::text`,
    );
    const outcomes: ScanOutcome[] = [];
    for (const f of claimed) outcomes.push(await this.scanOne(t, f));
    return outcomes;
  }

  private async scanOne(t: TenantRef, f: Claimed): Promise<ScanOutcome> {
    const qKey = f.quarantine_key;
    if (!qKey) return this.finishRejected(t, f, 'upload_missing');
    const read = await this.storage.readBounded(this.storage.quarantine, qKey, Number(f.size_bytes));
    if (read.kind === 'missing') return this.finishRejected(t, f, 'upload_missing');
    if (read.kind === 'too_large') return this.finishRejected(t, f, 'too_large');
    const bytes = read.bytes;
    const { detected, problem } = contentProblem(bytes, f.mime);
    if (problem || !detected) return this.finishRejected(t, f, problem ?? 'type_not_allowed', detected);

    let verdict;
    try {
      verdict = await this.scanner.scan(bytes);
    } catch (err) {
      const detail = err instanceof ScannerUnavailable ? err.detail : (err as Error).name;
      return this.finishUnscanned(t, f, detail);
    }
    await this.beforeFinalize?.(f.id);

    if (verdict.verdict === 'infected') {
      // Ordinary ClamAV detection, whatever the signature; the name is recorded as data.
      const done = await this.finalize(t, f, { state: 'INFECTED', scanSignature: verdict.signature, release: true }, 'files.scan.infected', { signature: verdict.signature });
      if (done) {
        this.logger.warn(securityFields('files.scan.malware_detected', { tenantId: t.id, fileId: f.id, signature: verdict.signature }), 'Malware detected in an upload');
        await this.storage.remove(this.storage.quarantine, qKey).catch(() => undefined);
      }
      return done ? 'infected' : 'lost';
    }

    // FU4: promote exactly the scanned bytes, from memory, to a key no client can write.
    const sha = createHash('sha256').update(bytes).digest();
    const key = cleanKey(t.id, f.id, f.lease_token);
    await this.storage.put(this.storage.clean, key, bytes, detected);
    await this.afterPromotion?.(f.id);
    const done = await this.finalize(t, f, { state: 'CLEAN', cleanKey: key, sha256: sha, detectedType: detected, release: false }, 'files.scan.clean', {});
    if (!done) {
      // Lost the race (deleted, or re-claimed after our lease lapsed): undo OUR promotion only. The key
      // is unique to our lease, so another worker's published object is never touched (FU15).
      await this.storage.remove(this.storage.clean, key).catch(() => undefined);
      return 'lost';
    }
    await this.storage.remove(this.storage.quarantine, qKey).catch(() => undefined);
    await this.shards.tx(t.shardId, t.id, (tx) => tx.fileObject.updateMany({ where: { id: f.id, state: 'CLEAN' }, data: { quarantineKey: null } }));
    return 'clean';
  }

  private async finishRejected(t: TenantRef, f: Claimed, reason: string, detected: string | null = null): Promise<ScanOutcome> {
    const done = await this.finalize(t, f, { state: 'REJECTED', rejectionReason: reason, detectedType: detected, release: true }, 'files.scan.rejected', { reason });
    if (done && f.quarantine_key) await this.storage.remove(this.storage.quarantine, f.quarantine_key).catch(() => undefined);
    return done ? 'rejected' : 'lost';
  }

  /** FU3: the scanner couldn't decide. Retry with backoff, then SCAN_FAILED. Never clean. */
  private async finishUnscanned(t: TenantRef, f: Claimed, detail: string): Promise<ScanOutcome> {
    this.logger.warn({ event: 'files.scan.attempt_failed', tenantId: t.id, fileId: f.id, attempt: f.scan_attempts, detail }, 'Scan attempt failed');
    if (f.scan_attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MS[f.scan_attempts - 1] ?? 120_000;
      const n = await this.shards.tx(t.shardId, t.id, (tx) =>
        tx.$executeRaw`UPDATE file_object SET state = 'UPLOADED', lease_token = NULL, lease_until = NULL,
            next_scan_at = now() + (${wait} * interval '1 millisecond'), updated_at = now()
          WHERE tenant_id = ${t.id}::uuid AND id = ${f.id}::uuid AND state = 'SCANNING' AND lease_token = ${f.lease_token}::uuid`,
      );
      return n === 1 ? 'retry' : 'lost';
    }
    const done = await this.finalize(t, f, { state: 'SCAN_FAILED', release: true }, 'files.scan.failed', { attempts: f.scan_attempts });
    return done ? 'failed' : 'lost';
  }

  /**
   * The one conditional result write: only while still SCANNING under OUR lease. A terminal non-clean
   * result releases the reservation in the same statement, so it is released exactly once (FU13).
   */
  private async finalize(
    t: TenantRef,
    f: Claimed,
    r: { state: 'CLEAN' | 'INFECTED' | 'REJECTED' | 'SCAN_FAILED'; release: boolean; cleanKey?: string; sha256?: Buffer; detectedType?: string | null; scanSignature?: string; rejectionReason?: string },
    action: string,
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    const scanStatus = r.state === 'CLEAN' ? 'CLEAN' : r.state === 'INFECTED' ? 'INFECTED' : r.state === 'SCAN_FAILED' ? 'ERROR' : 'PENDING';
    return this.shards.tx(t.shardId, t.id, async (tx: TenantTx) => {
      const n = await tx.fileObject.updateMany({
        where: { id: f.id, state: 'SCANNING', leaseToken: f.lease_token },
        data: {
          state: r.state,
          scanStatus,
          leaseToken: null,
          leaseUntil: null,
          scannedAt: new Date(),
          updatedAt: new Date(),
          ...(r.release ? { reservedBytes: 0 } : {}),
          ...(r.cleanKey ? { cleanKey: r.cleanKey } : {}),
          ...(r.sha256 ? { sha256: new Uint8Array(r.sha256) } : {}),
          ...(r.detectedType !== undefined ? { detectedType: r.detectedType } : {}),
          ...(r.scanSignature ? { scanSignature: r.scanSignature } : {}),
          ...(r.rejectionReason ? { rejectionReason: r.rejectionReason } : {}),
        },
      });
      if (n.count !== 1) return false;
      await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action, entityType: 'file_object', entityId: f.id, after: { state: r.state, ...detail } });
      return true;
    });
  }

  /**
   * FU7 cleanup, idempotent:
   *  1. lapsed slots → ABANDONED (reservation released once, conditionally);
   *  2. dead files whose objects remain → objects removed, keys cleared;
   *  3. quarantine objects with no live record (e.g. a reused upload URL) → removed.
   */
  async cleanup(t: TenantRef): Promise<{ abandoned: number; purged: number; orphans: number }> {
    const abandoned = await this.shards.tx(t.shardId, t.id, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE file_object SET state = 'ABANDONED', reserved_bytes = 0, updated_at = now()
        WHERE tenant_id = ${t.id}::uuid AND state = 'PENDING_UPLOAD'
          AND upload_expires_at < now() - (${ABANDON_GRACE_MS} * interval '1 millisecond')
        RETURNING id::text`;
      for (const r of rows) {
        await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action: 'files.upload.abandoned', entityType: 'file_object', entityId: r.id, after: { state: 'ABANDONED' } });
      }
      return rows.length;
    });

    const dead = await this.shards.tx(t.shardId, t.id, (tx) =>
      tx.fileObject.findMany({
        where: { state: { in: ['DELETED', 'ABANDONED', 'REJECTED', 'INFECTED', 'SCAN_FAILED'] }, OR: [{ quarantineKey: { not: null } }, { cleanKey: { not: null } }] },
        select: { id: true, quarantineKey: true, cleanKey: true },
        take: 50,
      }),
    );
    for (const d of dead) {
      if (d.quarantineKey) await this.storage.remove(this.storage.quarantine, d.quarantineKey);
      if (d.cleanKey) await this.storage.remove(this.storage.clean, d.cleanKey);
      await this.shards.tx(t.shardId, t.id, (tx) =>
        tx.fileObject.updateMany({ where: { id: d.id, state: { in: ['DELETED', 'ABANDONED', 'REJECTED', 'INFECTED', 'SCAN_FAILED'] } }, data: { quarantineKey: null, cleanKey: null } }),
      );
    }

    let orphans = 0;
    for (const key of await this.storage.listKeys(this.storage.quarantine, `tenants/${t.id}/q/`, 200)) {
      const id = key.split('/').pop() ?? '';
      const live = await this.shards.tx(t.shardId, t.id, (tx) =>
        tx.fileObject.count({ where: { id: /^[0-9a-f-]{36}$/i.test(id) ? id : randomUUID(), state: { in: ['PENDING_UPLOAD', 'UPLOADED', 'SCANNING'] } } }),
      );
      if (live === 0) {
        await this.storage.remove(this.storage.quarantine, key);
        orphans++;
      }
    }
    return { abandoned, purged: dead.length, orphans };
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.running = this.runOnce()
        .catch((err: unknown) => this.logger.error({ event: 'files.scan.pass_failed', error: (err as Error).name }, 'File scan pass failed'))
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
