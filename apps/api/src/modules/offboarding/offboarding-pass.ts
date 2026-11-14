// Spec 0038 Q4, Q5: what the worker does for an institution that is leaving. It warns its IT Admins at 60 (the start),
// 45, 30, 14, 7 and 1 days left (14, 7 and 1 after an extension), each once, by email through the institution's
// outbox; the platform never knows an address (ADR-035), only how many were queued. When the window has ended it
// archives the institution and ends every session there. Postgres holds every state: a warning's row is written before
// its emails, and its emails name it, so a pass that stops anywhere is finished by the next one without sending twice.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { writePlatformAudit } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { archiveDue, daysLeft, dueWarning, type TenantStatusName } from '@univarse/domain';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { Outbox } from '../../shared/outbox/outbox.js';
import { IT_ADMIN_PERMISSION } from '../notices/notice-board.service.js';

const day = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });

/** The warning's email, as plain text: what's happening, when, and what to do. */
export function warningEmail(i: { legalName: string; endsAt: Date; daysLeft: number; extension: boolean }): { subject: string; text: string } {
  const when = day.format(i.endsAt);
  const lead = i.extension
    ? `UniVarse has given ${i.legalName} 14 more days. Its account now closes at the end of ${when}.`
    : i.daysLeft >= 60
      ? `${i.legalName} is leaving UniVarse. Its account closes at the end of ${when}, in 60 days.`
      : i.daysLeft === 1
        ? `${i.legalName}'s UniVarse account closes at the end of today, ${when}.`
        : `${i.legalName}'s UniVarse account closes at the end of ${when}, ${String(i.daysLeft)} days from now.`;
  return {
    subject: `UniVarse: ${i.legalName} closes on ${when}`,
    text:
      `${lead}\n\n` +
      'Until then, everyone at the institution can sign in and work as usual. After it, nobody can, and the institution’s data is deleted once two members of UniVarse staff approve it.\n\n' +
      'Before then, take a copy of your institution’s data: as an IT Admin, you can download it from your workspace.\n\n' +
      `You're getting this because you're an IT Admin for ${i.legalName} on UniVarse.`,
  };
}

@Injectable()
export class OffboardingPass {
  private readonly logger = new Logger('Offboarding');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly outbox: Outbox,
    private readonly audit: AuditWriter,
  ) {}

  /** One pass over every open offboarding. One institution's failure doesn't hold the others. */
  async pass(now = new Date()): Promise<void> {
    const open = await this.platform.platformTenantOffboarding.findMany({
      where: { cancelledAt: null },
      select: { id: true, tenantId: true, endsAt: true, archivedAt: true, sessionsEndedAt: true, extendedAt: true, tenant: { select: { status: true, shardId: true, legalName: true } } },
    });
    let failed = 0;
    for (const o of open) {
      try {
        await this.tenant(o, now);
      } catch (err) {
        failed += 1;
        this.logger.warn({ event: 'offboarding.tenant_failed', tenantId: o.tenantId, error: err instanceof Error ? err.name : 'unknown' }, 'An offboarding step failed; the next pass tries again');
      }
    }
    if (failed) throw new Error(`${String(failed)} offboarding(s) failed`);
  }

  private async tenant(
    o: { id: string; tenantId: string; endsAt: Date; archivedAt: Date | null; sessionsEndedAt: Date | null; extendedAt: Date | null; tenant: { status: string; shardId: string; legalName: string } },
    now: Date,
  ): Promise<void> {
    const status = o.tenant.status as TenantStatusName;
    if (status === 'PURGED') return;
    // A warning written but not queued (a pass that stopped): finish it first.
    const pending = await this.platform.platformOffboardingWarning.findMany({ where: { offboardingId: o.id, queuedAt: null }, select: { id: true, round: true, daysLeft: true } });
    for (const w of pending) await this.send(o, w, now);
    if (status === 'OFFBOARDING' || status === 'SUSPENDED') {
      const round = o.extendedAt ? 1 : 0;
      const sent = await this.platform.platformOffboardingWarning.findMany({ where: { offboardingId: o.id, round }, select: { daysLeft: true } });
      const due = dueWarning(round, o.endsAt, sent.map((s) => s.daysLeft), now);
      if (due !== null) {
        // Raw and by column: the worker's role inserts only these (the migration's grant). Once per round and day.
        const [w] = await this.platform.$queryRaw<{ id: string }[]>`
          INSERT INTO platform_offboarding_warning (offboarding_id, round, days_left) VALUES (${o.id}::uuid, ${round}::smallint, ${due}::smallint)
          ON CONFLICT (offboarding_id, round, days_left) DO NOTHING RETURNING id::text`;
        if (w) await this.send(o, { id: w.id, round, daysLeft: due }, now);
      }
    }
    if (archiveDue(status, o.endsAt, now)) await this.archive(o, now);
    const archivedAt = status === 'ARCHIVED' ? o.archivedAt : (await this.platform.platformTenantOffboarding.findUniqueOrThrow({ where: { id: o.id }, select: { archivedAt: true } })).archivedAt;
    const current = (await this.platform.tenant.findUniqueOrThrow({ where: { id: o.tenantId }, select: { status: true } })).status;
    if (current === 'ARCHIVED' && archivedAt && (!o.sessionsEndedAt || o.sessionsEndedAt < archivedAt)) await this.endSessions(o, now);
  }

  /** Q4: one warning's emails, one per IT Admin with an address, named by the warning so a retry adds none. */
  private async send(o: { id: string; tenantId: string; endsAt: Date; tenant: { shardId: string; legalName: string } }, w: { id: string; round: number; daysLeft: number }, now: Date): Promise<void> {
    const mail = warningEmail({ legalName: o.tenant.legalName, endsAt: o.endsAt, daysLeft: w.daysLeft, extension: w.round === 1 && w.daysLeft === 14 });
    const counts = await this.shards.tx(o.tenant.shardId, o.tenantId, async (tx) => {
      const admins = await tx.userAccount.findMany({
        where: {
          status: 'ACTIVE',
          email: { not: null },
          roleAssignments: { some: { revokedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], role: { permissions: { has: IT_ADMIN_PERMISSION } } } },
        },
        select: { email: true },
      });
      const already = await tx.outboxEvent.count({ where: { noticeId: w.id } });
      if (already > 0) return { itAdmins: admins.length, queued: Math.min(already, admins.length) };
      // The outbox's notice id names a platform message (a notice, or this warning): delivered even while suspended.
      for (const a of admins) if (a.email) await this.outbox.enqueueEmail(tx, o.tenantId, { to: a.email, ...mail }, 'core', { noticeId: w.id });
      return { itAdmins: admins.length, queued: admins.length };
    });
    await this.platform.$transaction(async (tx) => {
      const r = await tx.platformOffboardingWarning.updateMany({ where: { id: w.id, queuedAt: null }, data: { queuedAt: now, itAdmins: counts.itAdmins, emailsQueued: counts.queued } });
      if (r.count === 1) await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.offboarding_warning_sent', tenantId: o.tenantId, metadata: { offboardingId: o.id, round: w.round, daysLeft: w.daysLeft, itAdmins: counts.itAdmins } });
    });
  }

  /** Q5: OFFBOARDING → ARCHIVED, once the last day is over. */
  private async archive(o: { id: string; tenantId: string; endsAt: Date }, now: Date): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const n = await tx.tenant.updateMany({ where: { id: o.tenantId, status: 'OFFBOARDING' }, data: { status: 'ARCHIVED' } });
      if (n.count !== 1) return;
      await tx.platformTenantOffboarding.update({ where: { id: o.id }, data: { archivedAt: now }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.archived', tenantId: o.tenantId, metadata: { offboardingId: o.id, endedAt: o.endsAt.toISOString(), daysLeft: daysLeft(o.endsAt, now) } });
    });
  }

  /** Q5: every session and pending challenge at an archived institution ends, audited on both sides. */
  private async endSessions(o: { id: string; tenantId: string; tenant: { shardId: string } }, now: Date): Promise<void> {
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

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'offboarding.pass_failed', () => this.pass()).finally(() => {
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
