// Spec 0038 Q2–Q6: an institution's departure, from the console. One person, with a step-up (the permission's catalogue
// entry) and a reason from a fixed list. Starting opens a 60-day window ending on a day in Nigerian time; cancelling
// within it returns the institution to the status it had; an archived institution gets 14 more days, once. The worker
// sends the warnings (the IT Admins' addresses are the institution's, ADR-035), archives on the last day and ends the
// sessions: the console holds no tenant credential (A2). Every change is audited in its own transaction.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformOffboarding, PlatformTenantExportView } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import {
  cancellable,
  daysLeft,
  EXTENSION_DAYS,
  extendable,
  offboardable,
  OFFBOARDING_DAYS,
  offboardingNoteProblem,
  windowEnd,
  type OffboardingReason,
  type TenantStatusName,
} from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const iso = (d: Date | null) => d?.toISOString() ?? null;
const who = (u: { id: string; displayName: string } | null) => (u ? { id: u.id, name: u.displayName } : null);

@Injectable()
export class TenantOffboarding {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** Q2: ACTIVE or ONBOARDING → OFFBOARDING, with the window's end, in one transaction. */
  async start(actor: PlatformActor, tenantId: string, body: { reason: OffboardingReason; note?: string | undefined }, meta: RequestMeta, now = new Date()): Promise<void> {
    if (offboardingNoteProblem(body.reason, body.note)) {
      throw Object.assign(new ProblemError(422, 'tenant.offboarding_note', 'Invalid note'), { errors: [{ path: 'note', code: 'offboarding_note', message: 'Invalid note' }] });
    }
    const note = body.note?.trim() ? body.note.trim() : null;
    const ends = windowEnd(now, OFFBOARDING_DAYS);
    await this.db.$transaction(async (tx) => {
      const status = await this.lock(tx, tenantId);
      if (!offboardable(status)) throw new ProblemError(409, 'tenant.not_offboardable', 'Not offboardable');
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status }, data: { status: 'OFFBOARDING', offboardingStartedAt: now, purgeAfter: ends } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_offboardable', 'Not offboardable');
      // Raw and by column: the console role inserts only these (the migration's grant).
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform_tenant_offboarding (tenant_id, reason, note, previous_status, started_by, first_ends_at, ends_at, updated_at)
        VALUES (${tenantId}::uuid, ${body.reason}, ${note}, ${status}::"TenantStatus", ${actor.userId}::uuid, ${ends}, ${ends}, now())
        RETURNING id::text`;
      if (!row) throw new Error('platform_tenant_offboarding insert returned nothing');
      // The note is staff text: it stays on the row, out of the audit chain.
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.offboarding_started', metadata: { offboardingId: row.id, reason: body.reason, previousStatus: status, endsAt: ends.toISOString(), hasNote: note !== null } }, meta);
    });
  }

  /** Q2: OFFBOARDING → the status it had, while the window is open. Nothing has been lost yet. */
  async cancel(actor: PlatformActor, tenantId: string, meta: RequestMeta, now = new Date()): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const status = await this.lock(tx, tenantId);
      const open = await this.open(tx, tenantId);
      if (!open || !cancellable(status, open.endsAt, now)) throw new ProblemError(409, 'tenant.not_offboarding', 'Not offboarding');
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status: 'OFFBOARDING' }, data: { status: open.previousStatus, offboardingStartedAt: null, purgeAfter: null } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_offboarding', 'Not offboarding');
      await tx.platformTenantOffboarding.update({ where: { id: open.id }, data: { cancelledAt: now, cancelledBy: actor.userId, version: { increment: 1 } }, select: { id: true } });
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.offboarding_cancelled', metadata: { offboardingId: open.id, status: open.previousStatus } }, meta);
    });
  }

  /** Q6: ARCHIVED → OFFBOARDING for 14 more days, once, with a reason. */
  async extend(actor: PlatformActor, tenantId: string, reason: string, meta: RequestMeta, now = new Date()): Promise<void> {
    const ends = windowEnd(now, EXTENSION_DAYS);
    await this.db.$transaction(async (tx) => {
      const status = await this.lock(tx, tenantId);
      const open = await this.open(tx, tenantId);
      if (!open || !extendable(status, open.extendedAt ? 1 : 0)) throw new ProblemError(409, 'tenant.not_extendable', 'Not extendable');
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status: 'ARCHIVED' }, data: { status: 'OFFBOARDING', purgeAfter: ends } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_extendable', 'Not extendable');
      await tx.platformTenantOffboarding.update({
        where: { id: open.id },
        data: { extendedAt: now, extendedBy: actor.userId, extensionReason: reason.trim(), endsAt: ends, version: { increment: 1 } },
        select: { id: true },
      });
      // The reason is staff text: on the row, out of the audit chain.
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.offboarding_extended', metadata: { offboardingId: open.id, endsAt: ends.toISOString() } }, meta);
    });
  }

  /** The institution's latest offboarding, for its page, or null. */
  async view(tenantId: string, now = new Date()): Promise<PlatformOffboarding | null> {
    const r = await this.db.platformTenantOffboarding.findFirst({
      where: { tenantId },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        reason: true,
        note: true,
        previousStatus: true,
        startedAt: true,
        firstEndsAt: true,
        endsAt: true,
        cancelledAt: true,
        archivedAt: true,
        sessionsEndedAt: true,
        extendedAt: true,
        extensionReason: true,
        starter: { select: { id: true, displayName: true } },
        canceller: { select: { id: true, displayName: true } },
        extender: { select: { id: true, displayName: true } },
        warnings: { orderBy: { createdAt: 'asc' }, select: { round: true, daysLeft: true, itAdmins: true, emailsQueued: true, queuedAt: true } },
      },
    });
    if (!r) return null;
    return {
      id: r.id,
      reason: r.reason as OffboardingReason,
      note: r.note,
      previousStatus: r.previousStatus as 'ACTIVE' | 'ONBOARDING',
      startedAt: r.startedAt.toISOString(),
      startedBy: { id: r.starter.id, name: r.starter.displayName },
      firstEndsAt: r.firstEndsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      daysLeft: r.cancelledAt ? 0 : daysLeft(r.endsAt, now),
      cancelledAt: iso(r.cancelledAt),
      cancelledBy: who(r.canceller),
      archivedAt: iso(r.archivedAt),
      sessionsEndedAt: iso(r.sessionsEndedAt),
      extendedAt: iso(r.extendedAt),
      extendedBy: who(r.extender),
      extensionReason: r.extensionReason,
      warnings: r.warnings.map((w) => ({ ...w, queuedAt: iso(w.queuedAt) })),
    };
  }

  /** Q15, Q-B7: the institution's latest exports, as the worker mirrored them: state and counts only. */
  async exports(tenantId: string): Promise<PlatformTenantExportView[]> {
    const rows = await this.db.platformTenantExport.findMany({
      where: { tenantId },
      orderBy: { requestedAt: 'desc' },
      take: 5,
      select: { id: true, state: true, requestedAt: true, readyAt: true, expiresAt: true, failedAt: true, expiredAt: true, sizeBytes: true, tables: true, rows: true, files: true },
    });
    const n = (v: bigint | null) => (v === null ? null : Number(v));
    return rows.map((r) => ({
      id: r.id,
      state: r.state as PlatformTenantExportView['state'],
      requestedAt: r.requestedAt.toISOString(),
      readyAt: iso(r.readyAt),
      expiresAt: iso(r.expiresAt),
      failedAt: iso(r.failedAt),
      expiredAt: iso(r.expiredAt),
      sizeBytes: n(r.sizeBytes),
      tables: r.tables,
      rows: n(r.rows),
      files: r.files,
    }));
  }

  private open(tx: PlatformTx, tenantId: string) {
    return tx.platformTenantOffboarding.findFirst({ where: { tenantId, cancelledAt: null }, select: { id: true, endsAt: true, previousStatus: true, extendedAt: true } });
  }

  /** Locks the institution's row, so a start, a cancel, a suspension or the worker's archive can't cross. */
  private async lock(tx: PlatformTx, tenantId: string): Promise<TenantStatusName> {
    const [row] = await tx.$queryRaw<{ status: TenantStatusName }[]>`SELECT status::text AS status FROM tenant WHERE id = ${tenantId}::uuid FOR UPDATE`;
    if (!row) throw notFound();
    return row.status;
  }
}
