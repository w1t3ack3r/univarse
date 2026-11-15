// Spec 0038 Q7, Q8, Q-B6, Q-B10: the worker's side of the export. Every EXPORT_INTERVAL_MS it
//   1. looks at each served institution for exports waiting, being built, or changed lately, and mirrors them;
//   2. offers the ones to build to the `tenant-export` queue (BullMQ, one at a time, the job id the export's): Postgres
//      holds every state, so a queue that lost everything loses nothing, and a job queued twice runs once;
//   3. fails the waiting exports of an institution that has closed (Q5: no export after its window), wiping the
//      passphrase;
//   4. expires the ready exports whose 7 days are up, from the mirror, whatever the institution's status: the archive
//      is deleted first, then the row says so.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { FileStorage } from '../files/file-storage.js';
import { QUEUE_PREFIX } from '../provisioning/provisioning-queue.js';
import { ExportBuilder } from './export-builder.js';
import { isExportArchiveKey } from './export-keys.js';
import { ExportMirror, MIRRORED } from './export-mirror.js';

export const EXPORT_QUEUE = 'tenant-export';
const SERVED = ['ACTIVE', 'ONBOARDING', 'OFFBOARDING'] as const;
const CLOSED = ['ARCHIVED', 'PURGED'] as const;
const RECENT_MS = 86_400_000;

export interface PassCounts {
  offered: number;
  mirrored: number;
  closedFailed: number;
  expired: number;
}

@Injectable()
export class ExportPass {
  private readonly logger = new Logger('Export');
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly shards: ShardRegistry,
    private readonly storage: FileStorage,
    private readonly audit: AuditWriter,
    private readonly mirror: ExportMirror,
    private readonly builder: ExportBuilder,
  ) {}

  /** One pass. `offer` puts an export to build on the queue (tests build directly). One institution's failure holds no other. */
  async pass(now = new Date(), offer: (exportId: string) => Promise<void> = (id) => this.enqueue(id)): Promise<PassCounts> {
    const c: PassCounts = { offered: 0, mirrored: 0, closedFailed: 0, expired: 0 };
    let failed = 0;
    const served = await this.platform.tenant.findMany({ where: { status: { in: [...SERVED] } }, select: { id: true, shardId: true } });
    for (const t of served) {
      try {
        const rows = await this.shards.tx(t.shardId, t.id, (tx) =>
          tx.dataExport.findMany({
            where: { OR: [{ state: { in: ['REQUESTED', 'BUILDING'] } }, { updatedAt: { gt: new Date(now.getTime() - RECENT_MS) } }] },
            select: { ...MIRRORED, leaseUntil: true },
          }),
        );
        for (const r of rows) {
          await this.mirror.write(t.id, r);
          c.mirrored++;
          if (r.state === 'REQUESTED' || (r.state === 'BUILDING' && (!r.leaseUntil || r.leaseUntil < now))) {
            await offer(r.id);
            c.offered++;
          }
        }
      } catch (err) {
        failed++;
        this.logger.warn({ event: 'export.pass_tenant_failed', tenantId: t.id, error: err instanceof Error ? err.name : 'unknown' }, 'An export pass failed for an institution; the next pass tries again');
      }
    }
    c.closedFailed = await this.failClosed(now).catch((err: unknown) => {
      failed++;
      this.logger.warn({ event: 'export.close_failed', error: err instanceof Error ? err.name : 'unknown' }, 'Failing a closed institution\'s exports failed');
      return 0;
    });
    c.expired = await this.expire(now).catch((err: unknown) => {
      failed++;
      this.logger.warn({ event: 'export.expiry_failed', error: err instanceof Error ? err.name : 'unknown' }, 'Expiring exports failed');
      return 0;
    });
    if (failed) throw new Error(`${String(failed)} export step(s) failed`);
    return c;
  }

  /** Q5: an institution that closed while its export waited gets none; its passphrase is wiped. */
  private async failClosed(now: Date): Promise<number> {
    const waiting = await this.platform.platformTenantExport.findMany({
      where: { state: { in: ['REQUESTED', 'BUILDING'] }, tenant: { status: { in: [...CLOSED] } } },
      select: { id: true, tenantId: true, tenant: { select: { shardId: true } } },
    });
    let n = 0;
    for (const e of waiting) {
      const changed = await this.shards.tx(e.tenant.shardId, e.tenantId, async (tx) => {
        const k = await tx.$executeRaw`
          UPDATE data_export SET state = 'FAILED', passphrase_enc = NULL, lease_until = NULL, lease_token = NULL, failed_at = ${now},
            last_error = 'InstitutionClosed', updated_at = ${now}, version = version + 1
          WHERE tenant_id = ${e.tenantId}::uuid AND id = ${e.id}::uuid AND state IN ('REQUESTED', 'BUILDING')`;
        if (k === 1) {
          await this.audit.write(tx, e.tenantId, { actorType: 'SYSTEM', actorId: null, action: 'data.export.failed', entityType: 'data_export', entityId: e.id, after: { state: 'FAILED', error: 'InstitutionClosed' } });
        }
        return k === 1;
      });
      await this.mirror.sync(e.tenantId, e.tenant.shardId, e.id);
      if (changed) n++;
    }
    return n;
  }

  /** Q8, Q-B10: a ready export's 7 days are up: its archive goes, then its row says so, audited. */
  private async expire(now: Date): Promise<number> {
    const due = await this.platform.platformTenantExport.findMany({
      where: { state: 'READY', expiresAt: { lte: now } },
      select: { id: true, tenantId: true, tenant: { select: { shardId: true } } },
    });
    let n = 0;
    for (const e of due) {
      const row = await this.shards.tx(e.tenant.shardId, e.tenantId, (tx) => tx.dataExport.findUnique({ where: { id: e.id }, select: { state: true, objectKey: true, expiresAt: true } }));
      if (row?.state === 'READY' && row.expiresAt && row.expiresAt <= now) {
        if (row.objectKey && isExportArchiveKey(e.tenantId, e.id, row.objectKey)) await this.storage.remove(this.storage.exports, row.objectKey);
        const changed = await this.shards.tx(e.tenant.shardId, e.tenantId, async (tx) => {
          const k = await tx.$executeRaw`
            UPDATE data_export SET state = 'EXPIRED', expired_at = ${now}, updated_at = ${now}, version = version + 1
            WHERE tenant_id = ${e.tenantId}::uuid AND id = ${e.id}::uuid AND state = 'READY'`;
          if (k === 1) await this.audit.write(tx, e.tenantId, { actorType: 'SYSTEM', actorId: null, action: 'data.export.expired', entityType: 'data_export', entityId: e.id, after: { state: 'EXPIRED' } });
          return k === 1;
        });
        if (changed) n++;
      }
      await this.mirror.sync(e.tenantId, e.tenant.shardId, e.id);
    }
    return n;
  }

  private open(): { queue: Queue; connection: Redis } {
    if (this.queue && this.connection) return { queue: this.queue, connection: this.connection };
    // BullMQ's blocking commands need `maxRetriesPerRequest: null` on its connection.
    this.connection = new Redis(this.config.VALKEY_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err: Error) => this.logger.debug({ event: 'export.valkey_error', error: err.name }));
    this.queue = new Queue(EXPORT_QUEUE, { connection: this.connection, prefix: QUEUE_PREFIX });
    return { queue: this.queue, connection: this.connection };
  }

  private async enqueue(exportId: string): Promise<void> {
    const { queue } = this.open();
    await queue.add('build', { exportId }, { jobId: exportId, removeOnComplete: true, removeOnFail: true });
  }

  /** Starts the queue's consumer (one export at a time) and the pass's loop. Off when EXPORT_INTERVAL_MS is 0. */
  start(): void {
    const interval = this.config.EXPORT_INTERVAL_MS;
    if (interval <= 0) return;
    const { connection } = this.open();
    this.worker = new Worker(
      EXPORT_QUEUE,
      async (job) => {
        const exportId = (job.data as { exportId?: unknown }).exportId;
        // The queue carries an id and nothing else; the mirror, which the pass wrote from the registry, names the institution.
        if (typeof exportId !== 'string' || exportId !== job.id) return;
        await this.builder.build(exportId);
      },
      { connection: connection.duplicate(), prefix: QUEUE_PREFIX, concurrency: 1, lockDuration: 120_000 },
    );
    this.worker.on('error', (err: Error) => this.logger.warn({ event: 'export.queue_error', error: err.name }, 'The export queue reported an error'));
    const tick = () => {
      this.running = backgroundPass(this.logger, 'export.pass_failed', () => this.pass()).finally(() => {
        if (this.timer !== null) this.timer = setTimeout(tick, interval);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
    this.worker = null;
    this.queue = null;
    this.connection = null;
  }
}
