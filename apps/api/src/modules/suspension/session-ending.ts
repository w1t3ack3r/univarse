// Spec 0037 Q7: a suspension ends every session of the institution. The console records the suspension; its row is
// this job. The worker holds the tenant credential (A2), so it ends the sessions on the tenant side, audits that there,
// and records on the platform side that it's done, with how many: the console's resume waits for that, so a session
// stolen before a security incident's suspension never works again. Its own loop, so it never waits behind email.
// Idempotent: ending sessions twice ends nothing more, and the platform row is written once (a trigger).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { writePlatformAudit } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';

export const SUSPENSION_REVOKE_REASON = 'tenant_suspended';

@Injectable()
export class SuspensionSessionEnding {
  private readonly logger = new Logger('Suspension');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
  ) {}

  /** One suspension: every live session and pending MFA challenge at the institution ends, then the fact is recorded. */
  async endFor(s: { id: string; tenantId: string; shardId: string }): Promise<number> {
    const now = new Date();
    const ended = await this.shards.tx(s.shardId, s.tenantId, async (tx) => {
      const { count } = await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: now, revokeReason: SUSPENSION_REVOKE_REASON } });
      await tx.mfaChallenge.updateMany({ where: { usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.write(tx, s.tenantId, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'auth.sessions.ended_by_suspension',
        entityType: 'tenant',
        entityId: s.tenantId,
        after: { suspensionId: s.id, sessionsEnded: count },
      });
      return count;
    });
    await this.platform.$transaction(async (tx) => {
      const r = await tx.platformTenantSuspension.updateMany({ where: { id: s.id, sessionsEndedAt: null }, data: { sessionsEndedAt: now, sessionsEnded: ended } });
      if (r.count === 1) await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.sessions_ended', tenantId: s.tenantId, metadata: { suspensionId: s.id, sessionsEnded: ended } });
    });
    return ended;
  }

  /** One pass: every suspension whose sessions aren't ended yet. One institution's failure doesn't hold the others. */
  async pass(): Promise<void> {
    const pending = await this.platform.platformTenantSuspension.findMany({
      where: { sessionsEndedAt: null },
      orderBy: { suspendedAt: 'asc' },
      select: { id: true, tenantId: true, tenant: { select: { shardId: true } } },
    });
    let failed = 0;
    for (const s of pending) {
      try {
        await this.endFor({ id: s.id, tenantId: s.tenantId, shardId: s.tenant.shardId });
      } catch (err) {
        failed += 1;
        this.logger.warn({ event: 'suspension.sessions_end_failed', tenantId: s.tenantId, error: err instanceof Error ? err.name : 'unknown' }, 'Ending a suspended institution’s sessions failed; the next pass tries again');
      }
    }
    if (failed) throw new Error(`${String(failed)} suspension(s) still to end`);
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'suspension.pass_failed', () => this.pass()).finally(() => {
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
