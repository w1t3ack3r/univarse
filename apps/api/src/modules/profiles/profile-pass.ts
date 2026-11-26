// Spec 0041 Q5: the worker's pass for institutions that have no assigned profile: those live before P2-S0 (the seed's,
// the drill's, the stack's) and any the seed asked for. It covers ONBOARDING, ACTIVE and SUSPENDED institutions on a
// servable shard; OFFBOARDING, ARCHIVED and PURGED ones are frozen and never get one, and a REQUESTED or PROVISIONING
// one gets its profile from its provisioning job. It finds them by the platform's assignments in one query, so once
// every institution has one a pass costs that query alone. One institution's failure doesn't hold the others.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { isTemplateId, TEMPLATES, templateForType, type InstitutionTemplate, type TenantStatusName, type TenantTypeName } from '@univarse/domain';
import { ON_SERVABLE_SHARD, PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { ProfileAssigner } from './profile-assigner.js';

export const PROFILE_PASS_STATUSES: readonly TenantStatusName[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED'];

/** The institution's template: the one it was provisioned from (its id; the current version), else its type's. */
export function templateOf(t: { template: string | null; type: TenantTypeName }): InstitutionTemplate {
  const id = t.template?.split('@')[0];
  return TEMPLATES[id !== undefined && isTemplateId(id) ? id : templateForType(t.type)];
}

@Injectable()
export class ProfilePass {
  private readonly logger = new Logger('Profiles');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly assigner: ProfileAssigner,
  ) {}

  /** One pass. Returns how many it assigned and how many failed (counts only: never a name). */
  async pass(): Promise<{ assigned: number; failed: number }> {
    const due = await this.platform.tenant.findMany({
      where: { status: { in: [...PROFILE_PASS_STATUSES] }, ...ON_SERVABLE_SHARD, profileAssignments: { none: { status: 'ASSIGNED' } } },
      select: { id: true, shardId: true, type: true, template: true },
      orderBy: { id: 'asc' },
    });
    let assigned = 0;
    let failed = 0;
    for (const t of due) {
      const template = templateOf(t);
      try {
        const open = await this.assigner.open(t.id, template, 'BACKFILL');
        await this.shards.tx(t.shardId, t.id, (tx) => this.assigner.snapshot(tx, t.id, template, open));
        await this.assigner.close(t.id, template, open);
        assigned += 1;
      } catch (err) {
        failed += 1;
        const code = await this.assigner.fail(t.id, template, err);
        this.logger.warn({ event: 'profiles.assign_failed', tenantId: t.id, code }, 'An institution’s profile could not be assigned; the next pass tries again');
      }
    }
    // A failure is recorded on its row (FAILED, with its code, for the console) and retried by the next pass.
    if (assigned > 0 || failed > 0) this.logger.log({ event: 'profiles.pass', assigned, failed }, 'Profiles assigned');
    return { assigned, failed };
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'profiles.pass_failed', () => this.pass()).finally(() => {
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
