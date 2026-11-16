// Spec 0038 Q5 and Q-D1–Q-D4: an institution's archive and the session ending that follows it. The worker's pass calls
// these once the last day is over; the stack's test clock (`pnpm stack:clock archive <slug>`) calls them for one
// institution now, as the same role, through the same code. Nothing here sends an email.
import { Inject, Injectable } from '@nestjs/common';
import { writePlatformAudit } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { daysLeft, testClockArchiveProblem, type TestClockProblem } from '@univarse/domain';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';

/** Q-D2: what the test clock did, or why it refused. */
export type TestClockOutcome =
  | { readonly ok: true; readonly tenantId: string; readonly archived: 'now' | 'already'; readonly daysLeft: number; readonly sessionsEnded: boolean }
  | { readonly ok: false; readonly refused: Exclude<TestClockProblem, 'already_archived'> | 'no_tenant' };

@Injectable()
export class OffboardingArchive {
  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
  ) {}

  /** Q5: OFFBOARDING → ARCHIVED, once the last day is over (or now, by the stack's test clock, Q-D4). */
  async archive(o: { id: string; tenantId: string; endsAt: Date }, now: Date, testClock = false): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const n = await tx.tenant.updateMany({ where: { id: o.tenantId, status: 'OFFBOARDING' }, data: { status: 'ARCHIVED' } });
      if (n.count !== 1) return;
      await tx.platformTenantOffboarding.update({ where: { id: o.id }, data: { archivedAt: now }, select: { id: true } });
      await writePlatformAudit(tx, {
        actorId: null,
        action: 'platform.tenant.archived',
        tenantId: o.tenantId,
        metadata: { offboardingId: o.id, endedAt: o.endsAt.toISOString(), daysLeft: daysLeft(o.endsAt, now), ...(testClock ? { testClock: true } : {}) },
      });
    });
  }

  /** Q5: every session and pending challenge at an archived institution ends, audited on both sides. */
  async endSessions(o: { id: string; tenantId: string; tenant: { shardId: string } }, now: Date): Promise<void> {
    const ended = await this.shards.tx(o.tenant.shardId, o.tenantId, async (tx) => {
      const { count } = await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: now, revokeReason: 'tenant_archived' } });
      await tx.mfaChallenge.updateMany({ where: { usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.write(tx, o.tenantId, { actorType: 'SYSTEM', actorId: null, action: 'auth.sessions.ended_by_archive', entityType: 'tenant', entityId: o.tenantId, after: { offboardingId: o.id, sessionsEnded: count } });
      return count;
    });
    await this.platform.$transaction(async (tx) => {
      await tx.platformTenantOffboarding.update({ where: { id: o.id }, data: { sessionsEndedAt: now }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.archive_sessions_ended', tenantId: o.tenantId, metadata: { offboardingId: o.id, sessionsEnded: ended } });
    });
  }

  /**
   * Q-D1–Q-D4: the stack's test clock, for one institution: the archive and its session ending, now, as if its window
   * had ended. No warning is sent and no other clock or institution moves. Only an institution leaving that never went
   * live (its open offboarding started from ONBOARDING). The real time is recorded; the archive's audit says
   * `testClock` and the days that were left. Run again on an archived one, it finishes the session ending.
   */
  async byTestClock(slug: string, now = new Date()): Promise<TestClockOutcome> {
    const t = await this.platform.tenant.findUnique({ where: { slug }, select: { id: true, status: true, shardId: true } });
    if (!t) return { ok: false, refused: 'no_tenant' };
    const o = await this.platform.platformTenantOffboarding.findFirst({
      where: { tenantId: t.id, cancelledAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, tenantId: true, endsAt: true, sessionsEndedAt: true, previousStatus: true },
    });
    const problem = testClockArchiveProblem({ status: t.status, previousStatus: o?.previousStatus ?? null });
    if (!o || (problem && problem !== 'already_archived')) return { ok: false, refused: problem && problem !== 'already_archived' ? problem : 'not_offboarding' };
    const left = daysLeft(o.endsAt, now);
    if (!problem) await this.archive(o, now, true);
    const { archivedAt } = await this.platform.platformTenantOffboarding.findUniqueOrThrow({ where: { id: o.id }, select: { archivedAt: true } });
    const sessionsEnded = !!archivedAt && (!o.sessionsEndedAt || o.sessionsEndedAt < archivedAt);
    if (sessionsEnded) await this.endSessions({ id: o.id, tenantId: t.id, tenant: { shardId: t.shardId } }, now);
    return { ok: true, tenantId: t.id, archived: problem ? 'already' : 'now', daysLeft: left, sessionsEnded };
  }
}
