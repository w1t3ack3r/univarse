import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import type { DestinationStream } from 'pino';
import { problemType } from '../shared/errors/problem.js';
import { genRequestId, registerCsrfGuard, registerSecurityHeaders } from '../shared/http/fastify-hooks.js';
import { registerRequestContext, registerRequestSummary } from '../shared/observability/http-logging.js';
import { createLogger, NestPinoLogger } from '../shared/observability/logger.js';
import { securityFields } from '../shared/observability/security.js';
import { allowlist, type PlatformConfig } from './platform-config.js';
import { PlatformModule, type PlatformOverrides } from './platform.module.js';

/** The platform API's only public prefix (spec 0027 P3). Health is for the container network, never routed by the edge. */
export const PLATFORM_PREFIX = '/api/platform/v1/';

export interface CreatePlatformAppOptions extends PlatformOverrides {
  readonly logDestination?: DestinationStream;
}

const notFound = (reply: FastifyReply, requestId: string) =>
  reply.status(404).header('content-type', 'application/problem+json').send({ type: problemType('resource.not_found'), title: 'Not found', status: 404, code: 'resource.not_found', requestId });

/**
 * Spec 0027 P3, P4: the platform API's walls, before any route runs. A path outside `/api/platform/v1/` and
 * `/health/` is 404; an address outside the allowlist is 404 too, never 403, so the console's existence isn't
 * confirmed. Both are logged as security events, without the path's query.
 */
export function registerPlatformWalls(app: FastifyInstance, config: PlatformConfig): void {
  const allowed = allowlist(config.CONSOLE_ALLOWLIST);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/health/')) return;
    if (!path.startsWith(PLATFORM_PREFIX)) return notFound(reply, req.id);
    if (!allowed(req.ip)) {
      app.log.warn(securityFields('platform.allowlist_refused', { method: req.method }), 'Platform API request from outside the allowlist');
      return notFound(reply, req.id);
    }
  });
}

/** Builds the platform API (spec 0027 P1). Shared by platform.ts and the integration tests. */
export async function createPlatformApp(config: PlatformConfig, overrides: CreatePlatformAppOptions = {}): Promise<NestFastifyApplication> {
  const log = createLogger({
    service: 'platform-api',
    env: config.NODE_ENV,
    version: config.UNIVARSE_VERSION,
    level: config.NODE_ENV === 'test' && !overrides.logDestination ? 'silent' : config.LOG_LEVEL,
    ...(overrides.logDestination ? { destination: overrides.logDestination } : {}),
  });
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUSTED_PROXIES.length > 0 ? config.TRUSTED_PROXIES : false,
    genReqId: genRequestId,
    bodyLimit: 1_048_576,
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const app = await NestFactory.create<NestFastifyApplication>(PlatformModule.forRoot(config, overrides), adapter, { logger: new NestPinoLogger(log) });
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestContext(fastify);
  registerPlatformWalls(fastify, config);
  registerRequestSummary(fastify, log);
  registerCsrfGuard(fastify);
  registerSecurityHeaders(fastify, { production: config.NODE_ENV === 'production' });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
