import { Controller, Get, HttpCode, Inject, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { ProblemError } from '../../shared/errors/problem.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { NoTenant } from '../../shared/tenancy/tenant.guard.js';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** docs/14-observability-and-operations.md §7 */
@Controller('health')
@NoTenant()
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready() {
    try {
      await withTimeout(this.platform.$queryRaw`SELECT 1`, 500);
      const shards = await withTimeout(this.platform.shard.findMany({ where: { isActive: true } }), 500);
      // Readiness requires at least one reachable tenant shard.
      const first = shards[0];
      if (!first) throw new Error('no active shards');
      const client = await this.shards.client(first.id);
      await withTimeout(client.$queryRaw`SELECT 1`, 500);
    } catch (err) {
      // Reason goes to logs only; the public response stays generic.
      this.logger.warn(`Not ready: ${err instanceof Error ? err.message : String(err)}`);
      throw new ProblemError(503, 'server.not_ready', 'Service not ready');
    }
    return { status: 'ready' };
  }
}
