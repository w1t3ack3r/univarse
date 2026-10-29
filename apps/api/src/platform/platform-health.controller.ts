import { Controller, Get, HttpCode, Inject, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { ProblemError } from '../shared/errors/problem.js';
import { CONSOLE_DB } from './platform-config.js';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** The platform API's health (docs/14 §7): ready means the platform database answers as the console role. */
@Controller('health')
export class PlatformHealthController {
  private readonly logger = new Logger('PlatformHealth');

  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready() {
    try {
      await withTimeout(this.db.$queryRaw`SELECT 1`, 500);
      return { status: 'ready' };
    } catch (e) {
      this.logger.warn({ event: 'platform.health.not_ready', reason: (e as Error).message });
      throw new ProblemError(503, 'server.not_ready', 'Not ready');
    }
  }
}
