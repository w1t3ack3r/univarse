// Spec 0038 Q7, Q8 (T35): the institution's full export, for its IT Admins. The request makes the passphrase, seals it
// under the institution's key and answers with it, once; the worker builds the archive (export-builder.ts). The
// download streams the sealed archive from the exports bucket, audited, only here: there's no link that works anywhere
// else. The tenant is the Host's (TenantContext), never the request's; another institution's export is the same 404
// as one that doesn't exist.
import { Injectable } from '@nestjs/common';
import type { Permission } from '@univarse/contracts';
import { FieldCrypto } from '@univarse/crypto';
import { exportableStatus, exportDownloadable, exportRequestProblem, nextExportAllowedAt, passphraseFrom, type ExportState } from '@univarse/domain';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { INSTITUTION, PolicyService } from '../identity/policy.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';
import { FileStorage } from '../files/file-storage.js';
import { exportPassphraseAad, isExportArchiveKey } from './export-keys.js';

export const EXPORT_PERMISSION = 'data.export.request' satisfies Permission;


const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const iso = (d: Date | null) => d?.toISOString() ?? null;
const num = (n: bigint | number | null) => (n === null ? null : Number(n));

const SELECT = {
  id: true,
  state: true,
  requestedBy: true,
  requestedAt: true,
  readyAt: true,
  expiresAt: true,
  sizeBytes: true,
  tables: true,
  rows: true,
  files: true,
  sha256: true,
} as const;

type Row = {
  id: string;
  state: ExportState;
  requestedBy: string | null;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  sizeBytes: bigint | null;
  tables: number | null;
  rows: bigint | null;
  files: number | null;
  sha256: Uint8Array | null;
};

export interface ExportView {
  id: string;
  state: ExportState;
  requestedAt: string;
  requestedBy: { id: string; displayName: string } | null;
  readyAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  tables: number | null;
  rows: number | null;
  files: number | null;
  sha256: string | null;
  downloadable: boolean;
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
    private readonly crypto: FieldCrypto,
    private readonly storage: FileStorage,
    private readonly policy: PolicyService,
  ) {}

  /** Q7, Q-B4, Q-B5: one at a time, at most one a day. The passphrase is in this answer only. */
  async request(tenant: TenantContext, actor: Actor, meta: SessionMeta, now = new Date()): Promise<{ export: ExportView; passphrase: string }> {
    this.authorize(tenant, actor);
    const id = randomUUID();
    const passphrase = passphraseFrom(randomBytes(30));
    const row = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      // Serialises this institution's requests, so two at once can't both pass the daily limit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`data_export:${tenant.tenantId}`}, 0))`;
      const history = await tx.dataExport.findMany({ where: { requestedAt: { gt: new Date(now.getTime() - 48 * 3_600_000) } }, select: { state: true, requestedAt: true } });
      const open = await tx.dataExport.count({ where: { state: { in: ['REQUESTED', 'BUILDING'] } } });
      const problem = open > 0 ? 'export.in_progress' : exportRequestProblem(history, now);
      if (problem) throw new ProblemError(409, problem, problem === 'export.in_progress' ? 'An export is in progress' : 'Too soon');
      // Sealed inside the writing transaction (spec 0020 D15).
      const passphraseEnc = await this.crypto.encrypt(tenant.tenantId, Buffer.from(passphrase, 'utf8'), exportPassphraseAad(tenant.tenantId, id));
      const created = await tx.dataExport.create({ data: { id, tenantId: tenant.tenantId, requestedBy: actor.userId, requestedAt: now, passphraseEnc, updatedAt: now }, select: SELECT });
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'data.export.requested',
        entityType: 'data_export',
        entityId: id,
        after: { state: 'REQUESTED' },
        ...SessionService.auditMeta(meta),
      });
      return created;
    });
    const [view] = await this.views(tenant, [row], now);
    if (!view) throw new Error('export view missing');
    return { export: view, passphrase };
  }

  /** The institution's exports, newest first, and when the next request is allowed. */
  async list(tenant: TenantContext, actor: Actor, now = new Date()): Promise<{ data: ExportView[]; nextAllowedAt: string | null }> {
    this.authorize(tenant, actor);
    const rows = await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => tx.dataExport.findMany({ orderBy: { requestedAt: 'desc' }, take: 20, select: SELECT }));
    const recent = rows.filter((r) => r.requestedAt.getTime() > now.getTime() - 48 * 3_600_000);
    return { data: await this.views(tenant, rows, now), nextAllowedAt: iso(nextExportAllowedAt(recent, now)) };
  }

  /** Q8, Q-B9: the sealed archive, streamed. Audited before the first byte leaves. */
  async download(tenant: TenantContext, actor: Actor, id: string, meta: SessionMeta, now = new Date()): Promise<{ body: Readable; length: number; name: string }> {
    this.authorize(tenant, actor);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const row = await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => tx.dataExport.findUnique({ where: { id }, select: { id: true, state: true, expiresAt: true, objectKey: true } }));
    if (!row) throw notFound();
    if (!exportDownloadable(row, now) || !row.objectKey) throw new ProblemError(409, 'export.not_ready', 'Not ready');
    // The key is the one this institution's row names, under this institution's prefix: never anything else.
    if (!isExportArchiveKey(tenant.tenantId, row.id, row.objectKey)) throw notFound();
    const read = await this.storage.stream(this.storage.exports, row.objectKey);
    if (read.kind === 'missing') throw new ProblemError(409, 'export.not_ready', 'Not ready');
    try {
      await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) =>
        this.audit.write(tx, tenant.tenantId, {
          actorType: 'USER',
          actorId: actor.userId,
          action: 'data.export.downloaded',
          entityType: 'data_export',
          entityId: row.id,
          after: { bytes: read.length },
          ...SessionService.auditMeta(meta),
        }),
      );
    } catch (err) {
      read.body.destroy();
      throw err;
    }
    const day = now.toISOString().slice(0, 10);
    return { body: read.body, length: read.length, name: `${tenant.slug}-export-${day}.zip` };
  }

  /** Q1, T35: an IT Admin of the whole institution, at an institution that is served. Anything else is 404. */
  private authorize(tenant: TenantContext, actor: Actor): void {
    if (!exportableStatus(tenant.status) || !this.policy.can(actor, EXPORT_PERMISSION, INSTITUTION)) throw notFound();
  }

  private async views(tenant: TenantContext, rows: Row[], now: Date): Promise<ExportView[]> {
    const ids = [...new Set(rows.map((r) => r.requestedBy).filter((x): x is string => x !== null))];
    const names = ids.length
      ? new Map(
          (await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => tx.userAccount.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }))).map((u) => [u.id, u.displayName]),
        )
      : new Map<string, string>();
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      requestedAt: r.requestedAt.toISOString(),
      requestedBy: r.requestedBy ? { id: r.requestedBy, displayName: names.get(r.requestedBy) ?? 'Former user' } : null,
      readyAt: iso(r.readyAt),
      expiresAt: iso(r.expiresAt),
      sizeBytes: num(r.sizeBytes),
      tables: r.tables,
      rows: num(r.rows),
      files: r.files,
      sha256: r.sha256 ? Buffer.from(r.sha256).toString('hex') : null,
      downloadable: exportDownloadable(r, now),
    }));
  }
}
