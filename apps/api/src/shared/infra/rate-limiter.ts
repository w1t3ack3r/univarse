import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';

export const VALKEY = Symbol('VALKEY');

export interface RateRule {
  readonly limit: number;
  readonly windowSec: number;
}

/**
 * Fixed-window counters in Valkey (docs/06 §7).
 * Fails OPEN if Valkey is unreachable — account lockout in the database still bounds guessing,
 * and an outage of the limiter must not lock every student out on registration day.
 */
@Injectable()
export class RateLimiter implements OnApplicationShutdown {
  private readonly logger = new Logger('RateLimiter');

  constructor(@Inject(VALKEY) private readonly redis: Redis) {}

  /** Records a hit against every rule; returns the longest retry-after among exceeded rules. */
  async hit(key: string, rules: readonly RateRule[]): Promise<{ allowed: boolean; retryAfterSec: number }> {
    try {
      let retryAfterSec = 0;
      for (const r of rules) {
        const k = `rl:${key}:${r.windowSec}`;
        const res = await this.redis.multi().incr(k).expire(k, r.windowSec, 'NX').ttl(k).exec();
        const count = Number(res?.[0]?.[1] ?? 0);
        const ttl = Number(res?.[2]?.[1] ?? r.windowSec);
        if (count > r.limit) retryAfterSec = Math.max(retryAfterSec, ttl > 0 ? ttl : r.windowSec);
      }
      return { allowed: retryAfterSec === 0, retryAfterSec };
    } catch (err) {
      this.logger.warn(`Rate limiter unavailable, failing open: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, retryAfterSec: 0 };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}
