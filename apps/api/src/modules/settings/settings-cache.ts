// Per-instance settings cache with cross-instance invalidation (spec 0007 ST10, ST11).
//   - Keys are tenant-scoped: settings:{tenantId}:{scopeKey}:{key}. Nothing is shared across tenants.
//   - A committed change publishes {tenantId, scopeKey, key, version} on Valkey; every instance evicts.
//   - A per-entry generation stops a read that began before an eviction from re-caching the old value.
//   - The TTL bounds staleness when a message is lost (D2: ≤ 30 s). Valkey down: reads go to the DB.
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { VALKEY } from '../../shared/infra/rate-limiter.js';

export const SETTINGS_CHANNEL = 'uv:settings:invalidate';

export interface CachedSetting {
  /** null = no override (default applies). */
  readonly value: unknown;
  readonly version: number;
  readonly updatedAt: Date | null;
  readonly updatedById: string | null;
}

interface Entry extends CachedSetting {
  readonly expiresAt: number;
}

const Invalidation = z.object({
  tenantId: z.uuid(),
  scopeKey: z.string().min(1).max(200),
  key: z.string().min(1).max(200),
  version: z.number().int().min(0),
});
export type Invalidation = z.infer<typeof Invalidation>;

export const cacheKey = (tenantId: string, scopeKey: string, key: string) => `settings:${tenantId}:${scopeKey}:${key}`;

@Injectable()
export class SettingsCache implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SettingsCache');
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Map<string, number>();
  private subscriber: Redis | null = null;
  private readonly ttlMs: number;
  /** Invalidations received from the bus (tests wait on it). */
  received = 0;

  constructor(
    @Inject(VALKEY) private readonly publisher: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlMs = config.SETTINGS_CACHE_TTL_MS;
  }

  onModuleInit(): void {
    // A dedicated connection: a subscribed client can't run other commands. ioredis reconnects and
    // re-subscribes by itself; startup never waits on Valkey (ST11d).
    const sub = this.publisher.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    sub.on('error', (err: Error) => this.logger.warn({ error: err.name }, 'Settings invalidation subscriber error'));
    sub.on('message', (_channel: string, message: string) => this.onMessage(message));
    sub.subscribe(SETTINGS_CHANNEL).catch((err: unknown) => this.logger.warn({ error: (err as Error).name }, 'Subscribe failed'));
    this.subscriber = sub;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopListening();
  }

  /** Stops receiving invalidations (shutdown; tests simulate a lost message with it). */
  async stopListening(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) sub.disconnect();
    await Promise.resolve();
  }

  get(id: string): CachedSetting | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return e;
  }

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  /** Caches only if nothing evicted the entry since `generation` was read (ST11c). */
  setIfUnchanged(id: string, generation: number, value: CachedSetting): void {
    if (this.ttlMs <= 0 || this.generation(id) !== generation) return;
    this.entries.set(id, { ...value, expiresAt: Date.now() + this.ttlMs });
  }

  evict(id: string): void {
    this.entries.delete(id);
    this.generations.set(id, this.generation(id) + 1);
  }

  /** After a committed change: evict here, then tell the other instances. Never throws (ST11d). */
  async publish(inv: Invalidation): Promise<void> {
    this.evict(cacheKey(inv.tenantId, inv.scopeKey, inv.key));
    try {
      await this.publisher.publish(SETTINGS_CHANNEL, JSON.stringify(inv));
    } catch (err) {
      // Other instances converge within the TTL.
      this.logger.warn({ tenantId: inv.tenantId, key: inv.key, error: (err as Error).name }, 'Settings invalidation not published');
    }
  }

  private onMessage(message: string): void {
    let parsed: Invalidation;
    try {
      parsed = Invalidation.parse(JSON.parse(message));
    } catch {
      this.logger.warn('Malformed settings invalidation ignored');
      return;
    }
    this.evict(cacheKey(parsed.tenantId, parsed.scopeKey, parsed.key));
    this.received++;
  }
}
