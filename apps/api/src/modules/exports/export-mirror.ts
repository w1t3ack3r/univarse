// Spec 0038 Q8, Q-B7: the platform's view of an institution's export: its state, dates, size and counts, copied from
// the institution's own row, never its passphrase, its archive's key or its content. Written only by the worker (the
// console holds no tenant credential, A2). The id is the institution's export id; the institution is the caller's,
// which came from the registry, never from a job.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';

export const MIRRORED = {
  id: true,
  state: true,
  requestedAt: true,
  readyAt: true,
  expiresAt: true,
  failedAt: true,
  expiredAt: true,
  sizeBytes: true,
  tables: true,
  rows: true,
  files: true,
} as const;

export interface MirroredRow {
  id: string;
  state: string;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  failedAt: Date | null;
  expiredAt: Date | null;
  sizeBytes: bigint | null;
  tables: number | null;
  rows: bigint | null;
  files: number | null;
}

@Injectable()
export class ExportMirror {
  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
  ) {}

  /** Copies one export's row as it stands now. */
  async sync(tenantId: string, shardId: string, exportId: string): Promise<void> {
    const row = await this.shards.tx(shardId, tenantId, (tx) => tx.dataExport.findUnique({ where: { id: exportId }, select: MIRRORED }));
    if (row) await this.write(tenantId, row);
  }

  /** Writes the platform's copy of a row read from `tenantId`'s own database. */
  async write(tenantId: string, r: MirroredRow): Promise<void> {
    const data = {
      state: r.state,
      readyAt: r.readyAt,
      expiresAt: r.expiresAt,
      failedAt: r.failedAt,
      expiredAt: r.expiredAt,
      sizeBytes: r.sizeBytes,
      tables: r.tables,
      rows: r.rows,
      files: r.files,
      updatedAt: new Date(),
    };
    // Scoped by institution: an id that is another institution's mirror is never touched (its trigger refuses a move).
    const n = await this.platform.platformTenantExport.updateMany({ where: { id: r.id, tenantId }, data });
    if (n.count === 0) {
      await this.platform.platformTenantExport.createMany({ data: [{ id: r.id, tenantId, requestedAt: r.requestedAt, ...data }], skipDuplicates: true });
    }
  }
}
