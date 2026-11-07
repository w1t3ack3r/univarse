// Spec 0032 Q12: a finished change keeps its row, as the record that it happened; its addresses and codes go. One pass
// an hour in the worker, institution by institution, each under its own tenant context. On a separate loop, so it never
// delays email, keys or scans.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { CONTACT_UNDO_WINDOW_MS } from '@univarse/domain';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';

const HOUR_MS = 3_600_000;

@Injectable()
export class ContactBlanker {
  private readonly logger = new Logger('Contact');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
  ) {}

  /** One institution. Returns how many rows lost their addresses. */
  async blankTenant(tenant: { id: string; shardId: string }, now = new Date()): Promise<number> {
    return this.shards.tx(tenant.shardId, tenant.id, async (tx) => {
      const { count } = await tx.contactChange.updateMany({
        where: {
          blankedAt: null,
          OR: [
            { status: 'UNDONE' },
            { status: 'CONFIRMED', confirmedAt: { lt: new Date(now.getTime() - CONTACT_UNDO_WINDOW_MS) } },
            { status: { in: ['PENDING', 'REPLACED'] }, expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } },
          ],
        },
        data: { newAddressEnc: null, oldAddressEnc: null, newAddressHash: null, oldAddressHash: null, codeHash: null, undoHash: null, blankedAt: now },
      });
      return count;
    });
  }

  private async pass(): Promise<void> {
    const tenants = await this.platform.tenant.findMany({ select: { id: true, shardId: true } });
    for (const t of tenants) await this.blankTenant(t);
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.running = backgroundPass(this.logger, 'identity.contact.blank_failed', () => this.pass()).finally(() => {
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
