import { Controller, Get, HttpCode, Inject, Logger } from '@nestjs/common';
import { HealthOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
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

  @Contract(HealthOps.live)
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Contract(HealthOps.ready)
  @Get('ready')
  @HttpCode(200)
  async ready() {
    try {
      await withTimeout(this.platform.$queryRaw`SELECT 1`, 500);
      // Readiness needs a reachable tenant shard when one is ACTIVE. Spec 0039 Q10: with every shard in maintenance the
      // API is still ready, since answering 503 for them is its job then; with no shard registered at all, it isn't.
      const shards = await withTimeout(this.platform.shard.findMany({ where: { status: { in: ['ACTIVE', 'MAINTENANCE'] } }, select: { id: true, status: true } }), 500);
      if (shards.length === 0) throw new Error('no shards');
      const first = shards.find((s) => s.status === 'ACTIVE');
      if (first) {
        const client = await this.shards.client(first.id);
        await withTimeout(client.$queryRaw`SELECT 1`, 500);
      }
    } catch (err) {
      // Reason goes to logs only; the public response stays generic.
      this.logger.warn({ event: 'health.not_ready', err }, 'Not ready');
      throw new ProblemError(503, 'server.not_ready', 'Service not ready');
    }
    return { status: 'ready' };
  }
}
