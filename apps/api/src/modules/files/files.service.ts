// Spec 0010: own documents. Upload slot (quota reserved atomically) → complete → scanned by the worker
// → download (verified before any byte is sent) → delete (wins over any scan in flight).
import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { TenantModels, type TenantTx } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { declaredTypeProblem, MAX_FILE_BYTES, sanitiseFileName } from './file-types.js';
import { FileStorage, UPLOAD_TTL_SEC } from './file-storage.js';

type FileRow = TenantModels.Prisma.FileObjectGetPayload<object>;

export interface FileView {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly state: FileRow['state'];
  readonly type: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly scannedAt: string | null;
}

export interface UploadSlot {
  readonly file: FileView;
  readonly upload: { readonly url: string; readonly fields: Record<string, string> };
  readonly expiresAt: string;
}

export const quarantineKey = (tenantId: string, fileId: string) => `tenants/${tenantId}/q/${fileId}`;
export const cleanKey = (tenantId: string, fileId: string) => `tenants/${tenantId}/c/${fileId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const integrityFailure = () => new ProblemError(500, 'server.internal', 'Internal server error');

export const toView = (f: FileRow): FileView => ({
  id: f.id,
  name: f.originalName,
  sizeBytes: Number(f.sizeBytes),
  state: f.state,
  type: f.detectedType,
  rejectionReason: f.rejectionReason,
  createdAt: f.createdAt.toISOString(),
  scannedAt: f.scannedAt?.toISOString() ?? null,
});

/** The tenant's reserved total, under the per-tenant quota lock (FU13). */
export async function reservedTotal(tx: TenantTx, tenantId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT COALESCE(SUM(reserved_bytes), 0)::bigint AS total FROM file_object WHERE tenant_id = ${tenantId}::uuid`;
  return rows[0]?.total ?? 0n;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');
  /** Test hook (FU13): runs right after the quota total is read, inside the reservation transaction. */
  afterQuotaRead: (() => Promise<void>) | null = null;

  constructor(
    private readonly shards: ShardRegistry,
    private readonly storage: FileStorage,
    private readonly settings: SettingsService,
    private readonly audit: AuditWriter,
  ) {}

  /** FU5 + FU13: validate, reserve atomically, create the record, then presign one bounded POST. */
  async requestUpload(tenant: TenantContext, actor: Actor, input: { name: string; mime: string; sizeBytes: number }, meta: SessionMeta): Promise<UploadSlot> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_FILE_BYTES) {
      throw new ProblemError(422, 'file.too_large', 'File too large');
    }
    if (declaredTypeProblem(input.name, input.mime)) throw new ProblemError(422, 'file.type_not_allowed', 'File type not allowed');
    const quota = BigInt(await this.settings.get(tenant, 'files.storageQuotaBytes'));
    const id = randomUUID();
    const key = quarantineKey(tenant.tenantId, id);
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SEC * 1000);
    const size = BigInt(input.sizeBytes);

    const row = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      // One reservation at a time per tenant: concurrent slots can't both see the same headroom.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`files-quota:${tenant.tenantId}`}))`;
      const reserved = await reservedTotal(tx, tenant.tenantId);
      await this.afterQuotaRead?.();
      if (reserved + size > quota) throw new ProblemError(409, 'file.quota_exceeded', 'Storage quota exceeded');
      const created = await tx.fileObject.create({
        data: {
          id,
          tenantId: tenant.tenantId,
          bucketKey: key,
          quarantineKey: key,
          originalName: sanitiseFileName(input.name),
          mime: input.mime,
          sizeBytes: size,
          reservedBytes: size,
          uploadedById: actor.userId,
          uploadExpiresAt: expiresAt,
          state: 'PENDING_UPLOAD',
        },
      });
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'files.upload.requested',
        entityType: 'file_object',
        entityId: id,
        after: { name: created.originalName, mime: input.mime, sizeBytes: input.sizeBytes },
        ...SessionService.auditMeta(meta),
      });
      return created;
    });
    const upload = await this.storage.presignUpload(key, input.mime, input.sizeBytes);
    return { file: toView(row), upload, expiresAt: expiresAt.toISOString() };
  }

  /** The uploader says the bytes are in. Idempotent; a lapsed slot can't be completed. */
  async complete(tenant: TenantContext, actor: Actor, id: string, meta: SessionMeta): Promise<FileView> {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const f = await this.ownForUpdate(tx, tenant, actor, id);
      if (f.state === 'ABANDONED') throw new ProblemError(409, 'file.upload_incomplete', 'Upload slot expired');
      if (f.state !== 'PENDING_UPLOAD') return toView(f);
      if (f.uploadExpiresAt && f.uploadExpiresAt.getTime() < Date.now() - 60_000) {
        throw new ProblemError(409, 'file.upload_incomplete', 'Upload slot expired');
      }
      const now = new Date();
      const updated = await tx.fileObject.update({ where: { id: f.id }, data: { state: 'UPLOADED', completedAt: now, nextScanAt: now, updatedAt: now } });
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'files.upload.completed',
        entityType: 'file_object',
        entityId: f.id,
        after: { state: 'UPLOADED' },
        ...SessionService.auditMeta(meta),
      });
      return toView(updated);
    });
  }

  async list(tenant: TenantContext, actor: Actor): Promise<FileView[]> {
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const rows = await db.fileObject.findMany({
      where: { uploadedById: actor.userId, state: { notIn: ['DELETED', 'ABANDONED'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toView);
  }

  async view(tenant: TenantContext, actor: Actor, id: string): Promise<FileView> {
    return toView(await this.own(tenant, actor, id));
  }

  /**
   * FU14: the clean bytes, verified BEFORE any byte is sent. Read with the recorded size as a strict
   * bound, hash completely, compare, and only then hand back those same bytes. FU8: audited.
   */
  async download(tenant: TenantContext, actor: Actor, id: string, meta: SessionMeta): Promise<{ bytes: Buffer; name: string; type: string }> {
    const f = await this.own(tenant, actor, id);
    if (f.state !== 'CLEAN' || !f.cleanKey || !f.sha256 || !f.detectedType) {
      throw new ProblemError(409, 'file.not_ready', 'File not available');
    }
    const read = await this.storage.readBounded(this.storage.clean, f.cleanKey, Number(f.sizeBytes));
    const expected = Buffer.from(f.sha256);
    if (read.kind !== 'ok' || read.bytes.length !== Number(f.sizeBytes) || !createHash('sha256').update(read.bytes).digest().equals(expected)) {
      // Integrity event for humans; the caller gets nothing of the stored bytes.
      this.logger.error({ tenantId: tenant.tenantId, fileId: f.id, read: read.kind }, 'Clean object failed verification; download refused');
      throw integrityFailure();
    }
    await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) =>
      this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'files.downloaded',
        entityType: 'file_object',
        entityId: f.id,
        ...SessionService.auditMeta(meta),
      }),
    );
    return { bytes: read.bytes, name: f.originalName, type: f.detectedType };
  }

  /**
   * FU15 + FU7: deletion wins. The record becomes DELETED and its reservation is released (once,
   * conditionally) in one transaction; any scan result arriving later finds no SCANNING row to update.
   * Objects are removed after commit; cleanup finishes anything a crash leaves.
   */
  async remove(tenant: TenantContext, actor: Actor, id: string, meta: SessionMeta): Promise<void> {
    const deleted = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const f = await this.ownForUpdate(tx, tenant, actor, id);
      const now = new Date();
      await tx.fileObject.update({
        where: { id: f.id },
        data: { state: 'DELETED', deletedAt: now, reservedBytes: 0, leaseToken: null, leaseUntil: null, updatedAt: now },
      });
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'files.deleted',
        entityType: 'file_object',
        entityId: f.id,
        before: { state: f.state },
        after: { state: 'DELETED' },
        ...SessionService.auditMeta(meta),
      });
      return f;
    });
    await this.purgeObjects(tenant, deleted.id, { quarantine: deleted.quarantineKey, clean: deleted.cleanKey }).catch((err: unknown) =>
      this.logger.warn({ tenantId: tenant.tenantId, fileId: deleted.id, error: (err as Error).name }, 'Object removal deferred to cleanup'),
    );
  }

  /** Removes a dead file's objects, then clears its keys so cleanup knows it's done. Idempotent. */
  async purgeObjects(tenant: { tenantId: string; shardId: string }, fileId: string, keys: { quarantine: string | null; clean: string | null }): Promise<void> {
    if (keys.quarantine) await this.storage.remove(this.storage.quarantine, keys.quarantine);
    if (keys.clean) await this.storage.remove(this.storage.clean, keys.clean);
    await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) =>
      tx.fileObject.updateMany({
        where: { id: fileId, state: { in: ['DELETED', 'ABANDONED', 'REJECTED', 'INFECTED', 'SCAN_FAILED'] } },
        data: { quarantineKey: null, cleanKey: null },
      }),
    );
  }

  /** Own, live file, or the same 404 as a nonexistent id (FU1/FU2: no existence oracle). */
  private async own(tenant: TenantContext, actor: Actor, id: string): Promise<FileRow> {
    if (!UUID.test(id)) throw notFound();
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const f = await db.fileObject.findFirst({ where: { id, uploadedById: actor.userId, state: { not: 'DELETED' } } });
    if (!f) throw notFound();
    return f;
  }

  private async ownForUpdate(tx: TenantTx, tenant: TenantContext, actor: Actor, id: string): Promise<FileRow> {
    if (!UUID.test(id)) throw notFound();
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM file_object
      WHERE tenant_id = ${tenant.tenantId}::uuid AND id = ${id}::uuid AND uploaded_by_id = ${actor.userId}::uuid AND state <> 'DELETED'
      FOR UPDATE`;
    if (!locked[0]) throw notFound();
    return tx.fileObject.findUniqueOrThrow({ where: { id } });
  }
}
