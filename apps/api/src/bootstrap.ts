import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController, type FastifyInstance } from 'fastify';
import { AppModule, type AppOverrides } from './app.module.js';
import type { AppConfig } from './config/config.js';
import type { DestinationStream } from 'pino';
import { genRequestId, registerCsrfGuard, registerSecurityHeaders } from './shared/http/fastify-hooks.js';
import { registerRequestContext, registerRequestSummary } from './shared/observability/http-logging.js';
import { createLogger, NestPinoLogger } from './shared/observability/logger.js';

/** Builds the HTTP app. Shared by main.ts and the integration tests. */
export interface CreateAppOptions extends AppOverrides {
  /** Runs before routes are registered, e.g. to attach an `onRoute` collector (spec 0009 RS1). Tests only. */
  readonly beforeInit?: (fastify: FastifyInstance) => void;
  /** Tests that assert on log lines capture them here (spec 0012); otherwise tests log nothing. */
  readonly logDestination?: DestinationStream;
}

export async function createApp(config: AppConfig, overrides: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  // Spec 0012 OB1: one Pino instance, Fastify's own logger and Nest's, configured in one place.
  const log = createLogger({
    service: 'api',
    env: config.NODE_ENV,
    version: config.UNIVARSE_VERSION,
    level: config.NODE_ENV === 'test' && !overrides.logDestination ? 'silent' : config.LOG_LEVEL,
    ...(overrides.logDestination ? { destination: overrides.logDestination } : {}),
  });
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUSTED_PROXIES.length > 0 ? config.TRUSTED_PROXIES : false,
    genReqId: genRequestId,
    bodyLimit: 1_048_576, // 1 MiB; uploads go direct to object storage (docs/06 §9)
    loggerInstance: log,
    // One summary line per request instead (OB3). Fastify 5.12 takes this through a LogController.
    logController: new LogController({ disableRequestLogging: true }),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config, overrides), adapter, {
    logger: new NestPinoLogger(log),
  });
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestContext(fastify); // first: every later hook, guard and handler runs inside it
  overrides.beforeInit?.(fastify);
  registerRequestSummary(fastify, log);
  registerCsrfGuard(fastify);
  registerSecurityHeaders(fastify, { production: config.NODE_ENV === 'production' });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
