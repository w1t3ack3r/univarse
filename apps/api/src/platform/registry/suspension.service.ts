// Spec 0037 Q6, Q7: suspending an institution and resuming it, from the console. One person, with a step-up (the
// permission's catalogue entry) and a reason from a fixed list. The status change takes effect at once: the tenant row's
// capture trigger invalidates every API instance's cache (spec 0016), and the tenant guard answers 423 from then on.
// The suspension's row is also the worker's job: it ends every session of the institution (the console holds no tenant
// credential, A2) and records that it did. A resume waits for that, so no session from before comes back.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformSuspension } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { resumableTo, resumeRefusal, suspendable, suspensionNoteProblem, type SuspensionReason, type TenantStatusName } from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

export const SUSPENSION_HISTORY = 10;

@Injectable()
export class TenantSuspension {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** Q6: ACTIVE or ONBOARDING → SUSPENDED, with the reason and the status to return to, in one transaction. */
  async suspend(actor: PlatformActor, tenantId: string, body: { reason: SuspensionReason; note?: string | undefined }, meta: RequestMeta): Promise<void> {
    if (suspensionNoteProblem(body.reason, body.note)) {
      throw Object.assign(new ProblemError(422, 'tenant.suspension_note', 'Invalid note'), { errors: [{ path: 'note', code: 'suspension_note', message: 'Invalid note' }] });
    }
    const note = body.note?.trim() ? body.note.trim() : null;
    await this.db.$transaction(async (tx) => {
      const status = await this.lock(tx, tenantId);
      if (!suspendable(status)) throw new ProblemError(409, 'tenant.not_suspendable', 'Not suspendable');
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status }, data: { status: 'SUSPENDED' } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_suspendable', 'Not suspendable');
      // Raw and by column: the console role inserts only these (the migration's grant).
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform_tenant_suspension (tenant_id, reason, note, previous_status, suspended_by, updated_at)
        VALUES (${tenantId}::uuid, ${body.reason}, ${note}, ${status}::"TenantStatus", ${actor.userId}::uuid, now())
        RETURNING id::text`;
      if (!row) throw new Error('platform_tenant_suspension insert returned nothing');
      // The note is staff text: it stays on the suspension's row, out of the audit chain's metadata.
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.suspended', metadata: { suspensionId: row.id, reason: body.reason, previousStatus: status, hasNote: note !== null } }, meta);
    });
  }

  /** Q6, Q7: SUSPENDED → the status it had, once the worker has ended the sessions. */
  async resume(actor: PlatformActor, tenantId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const status = await this.lock(tx, tenantId);
      const open = await tx.platformTenantSuspension.findFirst({
        where: { tenantId, resumedAt: null },
        select: { id: true, previousStatus: true, sessionsEndedAt: true, version: true },
      });
      const refusal = resumeRefusal({ status }, open);
      if (refusal === 'not_suspended') throw new ProblemError(409, 'tenant.not_suspended', 'Not suspended');
      if (refusal === 'sessions_ending') throw new ProblemError(409, 'tenant.sessions_ending', 'Sessions are still being ended');
      // The seed's suspended institution has no row; it returns to ACTIVE, as it was seeded from.
      const to = open && resumableTo(open.previousStatus) ? open.previousStatus : 'ACTIVE';
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status: 'SUSPENDED' }, data: { status: to } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_suspended', 'Not suspended');
      if (open) {
        const r = await tx.platformTenantSuspension.updateMany({
          where: { id: open.id, resumedAt: null, version: open.version },
          data: { resumedAt: new Date(), resumedBy: actor.userId, version: { increment: 1 } },
        });
        if (r.count !== 1) throw new ProblemError(409, 'tenant.not_suspended', 'Not suspended');
      }
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.resumed', metadata: { suspensionId: open?.id ?? null, status: to } }, meta);
    });
  }

  /** The institution's suspensions, newest first, for its detail page. */
  async history(tenantId: string): Promise<PlatformSuspension[]> {
    const rows = await this.db.platformTenantSuspension.findMany({
      where: { tenantId },
      orderBy: { suspendedAt: 'desc' },
      take: SUSPENSION_HISTORY,
      select: {
        id: true,
        reason: true,
        note: true,
        previousStatus: true,
        suspendedAt: true,
        resumedAt: true,
        sessionsEndedAt: true,
        sessionsEnded: true,
        suspender: { select: { id: true, displayName: true } },
        resumer: { select: { id: true, displayName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason as SuspensionReason,
      note: r.note,
      previousStatus: r.previousStatus as 'ACTIVE' | 'ONBOARDING',
      suspendedAt: r.suspendedAt.toISOString(),
      suspendedBy: { id: r.suspender.id, name: r.suspender.displayName },
      resumedAt: r.resumedAt?.toISOString() ?? null,
      resumedBy: r.resumer ? { id: r.resumer.id, name: r.resumer.displayName } : null,
      sessionsEndedAt: r.sessionsEndedAt?.toISOString() ?? null,
      sessionsEnded: r.sessionsEnded,
    }));
  }

  /** Locks the institution's row, so a suspend and a resume (or a go-live) can't cross. */
  private async lock(tx: PlatformTx, tenantId: string): Promise<TenantStatusName> {
    const [row] = await tx.$queryRaw<{ status: TenantStatusName }[]>`SELECT status::text AS status FROM tenant WHERE id = ${tenantId}::uuid FOR UPDATE`;
    if (!row) throw notFound();
    return row.status;
  }
}
