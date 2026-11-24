import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  createPlatformClient,
  createTenantShardClient,
  forTenant,
  shardUrl,
  withTenantTx,
  type PlatformClient,
  type TenantShardClient,
  type TenantTx,
  type TenantTxOptions,
} from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export const PLATFORM_DB = Symbol('PLATFORM_DB');

/** Spec 0039 Q10: the shard statuses whose institutions are served and worked on. */
export const SERVABLE_SHARD_STATUSES = ['ACTIVE', 'READY'] as const;
/**
 * Spec 0039 Q10: a platform `where` (on `tenant`, or on a relation to it) leaving out institutions whose shard is in
 * maintenance or retired, so a worker pass skips them rather than failing on each one.
 */
export const ON_SERVABLE_SHARD = { shard: { status: { in: [...SERVABLE_SHARD_STATUSES] } } };

/** Spec 0039 Q10: a shard in maintenance (or retired) is refused, so nothing reads or writes a half-migrated database. */
export class ShardUnavailableError extends Error {
  constructor(
    readonly shardId: string,
    readonly status: string,
  ) {
    super(`Shard ${shardId} is ${status.toLowerCase()}`);
    this.name = 'ShardUnavailableError';
  }
}

/** Spec 0039 Q11: a shard health check's fixed codes (no driver's message: it can carry a host). */
export type ShardProbeCode = 'unreachable' | 'timeout' | 'no_credentials' | 'unexpected';

/** Spec 0039 Q4 (T37): the environment holds no usable URL for this shard. */
export class NoShardUrlError extends Error {
  constructor(shardName: string, problem: string) {
    super(`Shard ${shardName}: no usable connection (${problem})`);
    this.name = 'NoShardUrlError';
  }
}

/** How long a shard's status is trusted before it's read again: the tenant cache's bound (Q10). */
const STATUS_TTL_MS = 60_000;

/** Lazily creates one Prisma client per tenant shard (docs/02 §7). */
@Injectable()
export class ShardRegistry implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly clients = new Map<string, TenantShardClient>();
  /** performance.now() deadlines, per shard. */
  private readonly statuses = new Map<string, { status: string; expiresAt: number }>();
  private readonly logger = new Logger('ShardRegistry');

  constructor(@Inject(PLATFORM_DB) private readonly platform: PlatformClient) {}

  /**
   * Opens platform + active shard connections at boot, so the first readiness probe
   * after a deploy reflects real health instead of connection-setup latency.
   * Failures are logged, not fatal: readiness reports them and the orchestrator retries.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.platform.$queryRaw`SELECT 1`;
      const shards = await this.platform.shard.findMany({ where: { status: 'ACTIVE' } });
      await Promise.all(shards.map(async (s) => (await this.client(s.id)).$queryRaw`SELECT 1`));
      this.logger.log({ event: 'db.warmed', shards: shards.length }, 'Warmed platform DB and shard connections');
    } catch (err) {
      this.logger.warn({ event: 'db.warm_up_failed', err }, 'Connection warm-up failed');
    }
  }

  async client(shardId: string): Promise<TenantShardClient> {
    await this.assertServable(shardId);
    return this.connect(shardId);
  }

  /**
   * Spec 0039 Q11: the shard's health, for the worker's check alone. `SELECT 1`, bounded, and **without** the
   * maintenance gate, so a shard in maintenance is still checked. Never used for data.
   */
  async probe(shardId: string, timeoutMs: number): Promise<{ ok: true; latencyMs: number } | { ok: false; code: ShardProbeCode }> {
    let client: TenantShardClient;
    try {
      client = await this.connect(shardId);
    } catch (err) {
      return { ok: false, code: err instanceof NoShardUrlError ? 'no_credentials' : 'unexpected' };
    }
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
    try {
      const r = await Promise.race([client.$queryRaw`SELECT 1`.then(() => 'ok' as const), timedOut]);
      if (r === 'timeout') return { ok: false, code: 'timeout' };
      return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    } catch {
      return { ok: false, code: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async connect(shardId: string): Promise<TenantShardClient> {
    const cached = this.clients.get(shardId);
    if (cached) return cached;
    const shard = await this.platform.shard.findUnique({ where: { id: shardId }, include: { server: { select: { secretRef: true } } } });
    if (!shard) throw new Error(`Shard ${shardId} unavailable`);
    // Spec 0039 Q4 (T37): the URL only from the environment, by the shard's own variable (a pool) or its server's
    // template with a dedicated database's name (never from the row itself).
    const r = shardUrl({ name: shard.name, kind: shard.kind, secretRef: shard.secretRef, database: shard.database, server: shard.server }, 'app', process.env);
    if ('problem' in r) throw new NoShardUrlError(shard.name, r.problem);
    const client = createTenantShardClient(r.url);
    this.clients.set(shardId, client);
    return client;
  }

  /** Q10: refuses a shard in maintenance or retired; its status is read at most once a minute. */
  private async assertServable(shardId: string): Promise<void> {
    const now = performance.now();
    let entry = this.statuses.get(shardId);
    if (!entry || entry.expiresAt <= now) {
      const row = await this.platform.shard.findUnique({ where: { id: shardId }, select: { status: true } });
      if (!row) throw new Error(`Shard ${shardId} unavailable`);
      entry = { status: row.status, expiresAt: now + STATUS_TTL_MS };
      this.statuses.set(shardId, entry);
    }
    if (!(SERVABLE_SHARD_STATUSES as readonly string[]).includes(entry.status)) throw new ShardUnavailableError(shardId, entry.status);
  }

  /** Tests and lifecycle changes: forget the cached statuses, so the next call reads them again. */
  forgetStatuses(): void {
    this.statuses.clear();
  }

  /** Single-operation access bound to a tenant (RLS context per operation). */
  async forTenant(shardId: string, tenantId: string) {
    return forTenant(await this.client(shardId), tenantId);
  }

  /** Multi-statement use cases: one transaction, RLS context set first. */
  async tx<T>(shardId: string, tenantId: string, fn: (tx: TenantTx) => Promise<T>, options?: TenantTxOptions): Promise<T> {
    return withTenantTx(await this.client(shardId), tenantId, fn, options);
  }

  /** For readiness checks only — never for data access. */
  activeClients(): ReadonlyMap<string, TenantShardClient> {
    return this.clients;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.$disconnect()));
    await this.platform.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PLATFORM_DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPlatformClient(config.PLATFORM_DATABASE_URL),
    },
    ShardRegistry,
  ],
  exports: [PLATFORM_DB, ShardRegistry],
})
export class DbModule {}
