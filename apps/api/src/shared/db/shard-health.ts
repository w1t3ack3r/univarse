// Spec 0039 Q11: the worker checks every shard once a minute (`SELECT 1` and its latency) and records it on the platform,
// for the console's Shards page: the console has no tenant credential (spec 0025 A2), so it reads this instead. A shard
// in maintenance is checked too (it may be reachable and only half-migrated); a retired one isn't. One shard's failure
// is recorded and the pass goes on. The codes are fixed, never a driver's message.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { backgroundPass } from '../observability/background.js';
import { PLATFORM_DB, ShardRegistry } from './db.module.js';

/** A check that hasn't answered in this long is a timeout. */
export const SHARD_PROBE_TIMEOUT_MS = 5_000;

@Injectable()
export class ShardHealthPass {
  private readonly logger = new Logger('ShardHealth');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
  ) {}

  /** One pass: every shard not retired, each checked and its row upserted. Returns how many failed. */
  async pass(now: () => Date = () => new Date()): Promise<number> {
    const shards = await this.platform.shard.findMany({
      where: { status: { not: 'RETIRED' } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    let failed = 0;
    for (const s of shards) {
      const r = await this.shards.probe(s.id, SHARD_PROBE_TIMEOUT_MS);
      const checkedAt = now();
      if (r.ok) {
        const row = {
          checkedAt,
          ok: true,
          latencyMs: r.latencyMs,
          lastSuccessAt: checkedAt,
          errorCode: null,
        };
        await this.platform.shardHealth.upsert({
          where: { shardId: s.id },
          create: { shardId: s.id, ...row },
          update: row,
          select: { shardId: true },
        });
      } else {
        failed += 1;
        // The last success stays as it was: the console shows how long a shard has been unreachable.
        const row = { checkedAt, ok: false, latencyMs: null, errorCode: r.code };
        await this.platform.shardHealth.upsert({
          where: { shardId: s.id },
          create: { shardId: s.id, ...row, lastSuccessAt: null },
          update: row,
          select: { shardId: true },
        });
        this.logger.warn(
          { event: 'shard.unhealthy', shard: s.name, code: r.code },
          'A shard did not answer its health check',
        );
      }
    }
    return failed;
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'shard.health_pass_failed', () =>
        this.pass(),
      ).finally(() => {
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
