// Spec 0037 Q15 (E25): the console inbox, computed when read from the tables each item comes from, so it can't disagree
// with the screens. Each person sees only what their role lets them act on, and an item leaves when its cause is
// resolved. No inbox table. PR D adds open incidents and maintenance about to start; S9 adds SLA timers.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformInbox, PlatformInboxItem } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import {
  APPROVAL_KINDS,
  effectiveApprovalStatus,
  isApprovalKind,
  isPlatformRole,
  PLATFORM_ROLE_PERMISSIONS,
  securityLevel,
  type PlatformPermission,
  type ProvisioningErrorCode,
  type ProvisioningStepKey,
} from '@univarse/domain';
import { NO_TENANT } from '../../shared/observability/security-rollup.js';
import type { PlatformActor } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

const DAY_MS = 24 * 3_600_000;
/** How long a member's own decided request stays in their inbox. */
export const DECIDED_FOR_MS = 7 * DAY_MS;
/** The window of "act" security events shown. */
export const SECURITY_WINDOW_MS = DAY_MS;

@Injectable()
export class PlatformInboxView {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  async read(actor: PlatformActor, now = new Date()): Promise<PlatformInbox> {
    const can = (p: PlatformPermission) => isPlatformRole(actor.role) && PLATFORM_ROLE_PERMISSIONS[actor.role].includes(p);
    const items: PlatformInboxItem[] = [
      ...(await this.waiting(actor, can, now)),
      ...(await this.decided(actor, now)),
      ...(can('platform.tenant.provision') ? await this.failedProvisioning() : []),
      ...(can('platform.security.read') ? await this.securityAct(now) : []),
    ];
    return { items, count: items.length };
  }

  /** Requests another member made that this one could decide now: not theirs, not about them, not expired. */
  private async waiting(actor: PlatformActor, can: (p: PlatformPermission) => boolean, now: Date): Promise<PlatformInboxItem[]> {
    const kinds = Object.entries(APPROVAL_KINDS)
      .filter(([, k]) => can(k.approvePermission))
      .map(([name]) => name);
    if (kinds.length === 0) return [];
    const rows = await this.db.platformApproval.findMany({
      where: {
        kind: { in: kinds },
        status: 'PENDING',
        expiresAt: { gt: now },
        requestedBy: { not: actor.userId },
        OR: [{ subjectId: null }, { subjectId: { not: actor.userId } }],
      },
      orderBy: { expiresAt: 'asc' },
      select: { id: true, kind: true, expiresAt: true, requester: { select: { id: true, displayName: true } } },
    });
    return rows
      .filter((r) => isApprovalKind(r.kind))
      .map((r) => ({
        type: 'approval_waiting' as const,
        approvalId: r.id,
        kind: r.kind as 'staff.make_owner',
        requestedBy: { id: r.requester.id, name: r.requester.displayName },
        expiresAt: r.expiresAt.toISOString(),
      }));
  }

  /** The member's own requests decided (or expired) in the last week, so they learn the outcome. */
  private async decided(actor: PlatformActor, now: Date): Promise<PlatformInboxItem[]> {
    const since = new Date(now.getTime() - DECIDED_FOR_MS);
    const rows = await this.db.platformApproval.findMany({
      where: {
        requestedBy: actor.userId,
        OR: [
          { status: { in: ['REJECTED', 'EXECUTED', 'FAILED'] }, decidedAt: { gte: since } },
          { status: 'PENDING', expiresAt: { lte: now, gte: since } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, kind: true, status: true, decidedAt: true, expiresAt: true },
    });
    return rows
      .filter((r) => isApprovalKind(r.kind))
      .map((r) => ({
        type: 'approval_decided' as const,
        approvalId: r.id,
        kind: r.kind as 'staff.make_owner',
        status: effectiveApprovalStatus(r, now),
        decidedAt: (r.decidedAt ?? r.expiresAt).toISOString(),
      }));
  }

  /** Provisionings stopped at a step (spec 0034 Q8): they wait for someone to resume them. */
  private async failedProvisioning(): Promise<PlatformInboxItem[]> {
    const jobs = await this.db.provisioningJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'asc' },
      select: { errorStep: true, errorCode: true, updatedAt: true, tenant: { select: { id: true, slug: true, shortName: true } } },
    });
    return jobs
      .filter((j) => j.errorStep !== null && j.errorCode !== null)
      .map((j) => ({
        type: 'provisioning_failed' as const,
        tenant: { id: j.tenant.id, slug: j.tenant.slug, name: j.tenant.shortName },
        step: j.errorStep as ProvisioningStepKey,
        code: j.errorCode as ProvisioningErrorCode,
        failedAt: j.updatedAt.toISOString(),
      }));
  }

  /** Spec 0031 Q12's "act" events in the last day, per event and institution: "S3 shows; S6 tells". */
  private async securityAct(now: Date): Promise<PlatformInboxItem[]> {
    const since = new Date(now.getTime() - SECURITY_WINDOW_MS);
    const rows = await this.db.$queryRaw<{ event: string; tenant_id: string; count: bigint; last_seen_at: Date }[]>`
      SELECT event, tenant_id, SUM("count")::bigint AS count, MAX(last_seen_at) AS last_seen_at
        FROM platform_security_event_rollup
       WHERE minute >= ${since}
       GROUP BY event, tenant_id`;
    const act = rows.filter((r) => securityLevel(r.event) === 'act');
    const ids = [...new Set(act.map((r) => r.tenant_id).filter((t) => t !== NO_TENANT))];
    const names = ids.length ? await this.db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, shortName: true } }) : [];
    const named = new Map(names.map((t) => [t.id, t]));
    return act
      .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
      .map((r) => ({
        type: 'security_act' as const,
        event: r.event,
        count: Number(r.count),
        lastSeenAt: r.last_seen_at.toISOString(),
        tenant: r.tenant_id === NO_TENANT ? null : { id: r.tenant_id, slug: named.get(r.tenant_id)?.slug ?? null, name: named.get(r.tenant_id)?.shortName ?? null },
      }));
  }
}
