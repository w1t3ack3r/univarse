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
  withTenantTx,
  type PlatformClient,
  type TenantShardClient,
  type TenantTx,
} from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export const PLATFORM_DB = Symbol('PLATFORM_DB');

// A shard's secretRef names the env var holding its URL. Restricting the pattern stops a
// tampered registry row from reading unrelated secrets (e.g. SESSION_PEPPER).
const SECRET_REF = /^[A-Z0-9_]+_DATABASE_URL$/;

/** Lazily creates one Prisma client per tenant shard (docs/02 §7). */
@Injectable()
export class ShardRegistry implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly clients = new Map<string, TenantShardClient>();
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
      const shards = await this.platform.shard.findMany({ where: { isActive: true } });
      await Promise.all(shards.map(async (s) => (await this.client(s.id)).$queryRaw`SELECT 1`));
      this.logger.log({ event: 'db.warmed', shards: shards.length }, 'Warmed platform DB and shard connections');
    } catch (err) {
      this.logger.warn({ event: 'db.warm_up_failed', err }, 'Connection warm-up failed');
    }
  }

  async client(shardId: string): Promise<TenantShardClient> {
    const cached = this.clients.get(shardId);
    if (cached) return cached;
    const shard = await this.platform.shard.findUnique({ where: { id: shardId } });
    if (!shard?.isActive) throw new Error(`Shard ${shardId} unavailable`);
    if (!SECRET_REF.test(shard.secretRef)) throw new Error(`Shard ${shard.name} has an invalid secretRef`);
    const url = process.env[shard.secretRef];
    if (!url) throw new Error(`Missing connection secret ${shard.secretRef} for shard ${shard.name}`);
    const client = createTenantShardClient(url);
    this.clients.set(shardId, client);
    return client;
  }

  /** Single-operation access bound to a tenant (RLS context per operation). */
  async forTenant(shardId: string, tenantId: string) {
    return forTenant(await this.client(shardId), tenantId);
  }

  /** Multi-statement use cases: one transaction, RLS context set first. */
  async tx<T>(shardId: string, tenantId: string, fn: (tx: TenantTx) => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
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
