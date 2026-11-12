// Spec 0034 Q9: the go-live checklist's first item, reported as a fact with no personal data. For each institution
// still onboarding, the worker looks on its own tenant side for an active institution administrator with a confirmed
// authenticator, and records when one was found. Its own loop, so it never delays anything else.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { writePlatformAudit } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';

@Injectable()
export class OnboardingCheck {
  private readonly logger = new Logger('Onboarding');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
  ) {}

  /** One institution: whether its administrator is ready, recorded once. */
  async checkTenant(t: { id: string; shardId: string }): Promise<boolean> {
    const ready = await this.shards.tx(t.shardId, t.id, (tx) =>
      tx.userAccount.findFirst({
        where: {
          status: 'ACTIVE',
          roleAssignments: { some: { revokedAt: null, role: { key: 'INSTITUTION_ADMIN' } } },
          mfaFactors: { some: { confirmedAt: { not: null } } },
        },
        select: { id: true },
      }),
    );
    if (!ready) return false;
    await this.platform.$transaction(async (tx) => {
      const row = await tx.tenantOnboarding.findUnique({ where: { tenantId: t.id }, select: { adminReadyAt: true } });
      if (row?.adminReadyAt) return;
      const now = new Date();
      await tx.tenantOnboarding.upsert({
        where: { tenantId: t.id },
        create: { tenantId: t.id, adminReadyAt: now, checkedAt: now },
        update: { adminReadyAt: now, checkedAt: now },
        select: { tenantId: true },
      });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.admin_ready', tenantId: t.id, metadata: {} });
    });
    return true;
  }

  async pass(): Promise<void> {
    const tenants = await this.platform.tenant.findMany({
      where: { status: 'ONBOARDING', OR: [{ onboarding: null }, { onboarding: { adminReadyAt: null } }] },
      select: { id: true, shardId: true },
    });
    for (const t of tenants) await this.checkTenant(t);
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'provisioning.onboarding_check_failed', () => this.pass()).finally(() => {
        if (this.timer !== null) this.timer = setTimeout(tick, intervalMs);
      });
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
