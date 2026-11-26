// Spec 0041 Q5, Q6: assigning an institution its institution-type profile. One function, used by provisioning's
// template step and by `ProfilePass`; the seed only asks for one (a PENDING row with source SEED), which the pass then
// assigns. Three writes, each idempotent:
//   1. the platform's assignment row for this template version, PENDING (or FAILED back to PENDING);
//   2. in the institution's own transaction, its snapshot and the audit `setup.profile_assigned` (only when written);
//   3. the row marked ASSIGNED, with the platform's audit.
// Stopped between any two, the next run finds what was done and finishes the rest; nothing is written twice and no
// configuration the institution already has is touched. The content is never audited or logged: its hash is.
import { Inject, Injectable } from '@nestjs/common';
import { writePlatformAudit } from '@univarse/crypto';
import { profileContentHash, ProfileHashMismatch, recordProfileSnapshot, type PlatformClient, type TenantTx } from '@univarse/db';
import { canonicalJson, type InstitutionTemplate } from '@univarse/domain';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardUnavailableError } from '../../shared/db/db.module.js';

export type ProfileSource = 'PROVISIONING' | 'SEED' | 'BACKFILL';

/** The fixed codes a failed assignment records (the table's check holds the same list). Never a message. */
export const PROFILE_ERRORS = ['shard_unavailable', 'hash_mismatch', 'database', 'unexpected'] as const;
export type ProfileErrorCode = (typeof PROFILE_ERRORS)[number];

export function profileErrorCode(err: unknown): ProfileErrorCode {
  if (err instanceof ShardUnavailableError) return 'shard_unavailable';
  if (err instanceof ProfileHashMismatch) return 'hash_mismatch';
  const e = err as { code?: unknown; name?: string };
  if (typeof e.code === 'string' && /^P\d{4}$/.test(e.code)) return 'database';
  if (e.name?.startsWith('PrismaClient') || e.name === 'DriverAdapterError') return 'database';
  return 'unexpected';
}

/** What `open` found: the profile as canonical JSON, its hash, and the row's source (a seed's stays SEED). */
export interface OpenAssignment {
  readonly canonical: string;
  readonly contentHash: string;
  readonly source: ProfileSource;
}

const isUniqueViolation = (err: unknown) => (err as { code?: unknown }).code === 'P2002';

@Injectable()
export class ProfileAssigner {
  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly audit: AuditWriter,
  ) {}

  private key(tenantId: string, t: InstitutionTemplate) {
    return { tenantId_template_templateVersion: { tenantId, template: t.id, templateVersion: t.version } };
  }

  /**
   * Step 1: the platform's row for this version, created PENDING if there is none (a race with another run reads the
   * winner's), and a FAILED one put back to PENDING. A row whose hash isn't this version's content is refused.
   */
  async open(tenantId: string, t: InstitutionTemplate, source: ProfileSource): Promise<OpenAssignment> {
    const canonical = canonicalJson(t.profile);
    const contentHash = profileContentHash(canonical);
    const where = this.key(tenantId, t);
    const select = { status: true, contentHash: true, source: true } as const;
    let row = await this.platform.tenantProfileAssignment.findUnique({ where, select });
    if (!row) {
      try {
        row = await this.platform.tenantProfileAssignment.create({ data: { tenantId, template: t.id, templateVersion: t.version, contentHash, source }, select });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        row = await this.platform.tenantProfileAssignment.findUniqueOrThrow({ where, select });
      }
    }
    if (row.contentHash !== contentHash) throw new ProfileHashMismatch();
    if (row.status === 'FAILED') {
      await this.platform.tenantProfileAssignment.updateMany({ where: { tenantId, template: t.id, templateVersion: t.version, status: 'FAILED' }, data: { status: 'PENDING', errorCode: null } });
    }
    return { canonical, contentHash, source: row.source };
  }

  /** Step 2, in the caller's tenant transaction: the snapshot, and its audit when this run wrote it. */
  async snapshot(tx: TenantTx, tenantId: string, t: InstitutionTemplate, open: OpenAssignment): Promise<boolean> {
    const { created, contentHash } = await recordProfileSnapshot(tx, tenantId, { template: t.id, templateVersion: t.version, canonical: open.canonical, source: open.source });
    if (created) {
      await this.audit.write(tx, tenantId, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'setup.profile_assigned',
        entityType: 'tenant',
        entityId: tenantId,
        // `sha256`, not `contentHash`: the audit's redaction (spec 0002 A6) blanks any key naming a hash.
        after: { template: t.id, templateVersion: t.version, sha256: contentHash, source: open.source },
      });
    }
    return created;
  }

  /** Step 3: ASSIGNED, once the snapshot has committed. Only a PENDING row moves; an ASSIGNED one never changes. */
  async close(tenantId: string, t: InstitutionTemplate, open: OpenAssignment, now = new Date()): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const r = await tx.tenantProfileAssignment.updateMany({
        where: { tenantId, template: t.id, templateVersion: t.version, status: 'PENDING' },
        data: { status: 'ASSIGNED', assignedAt: now, errorCode: null },
      });
      if (r.count === 1) {
        await writePlatformAudit(tx, {
          actorId: null,
          action: 'platform.tenant.profile_assigned',
          tenantId,
          metadata: { template: t.id, templateVersion: t.version, sha256: open.contentHash, source: open.source },
        });
      }
    });
  }

  /** A failure's fixed code on a PENDING row (an ASSIGNED one stays as it is). */
  async fail(tenantId: string, t: InstitutionTemplate, err: unknown): Promise<ProfileErrorCode> {
    const code = profileErrorCode(err);
    await this.platform.tenantProfileAssignment
      .updateMany({ where: { tenantId, template: t.id, templateVersion: t.version, status: 'PENDING' }, data: { status: 'FAILED', errorCode: code } })
      .catch(() => undefined);
    return code;
  }
}
