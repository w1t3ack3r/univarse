import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AppModule, type AppOverrides } from './app.module.js';
import type { AppConfig } from './config/config.js';
import { genRequestId, registerCsrfGuard, registerSecurityHeaders } from './shared/http/fastify-hooks.js';

/** Builds the HTTP app. Shared by main.ts and the integration tests. */
export interface CreateAppOptions extends AppOverrides {
  /** Runs before routes are registered, e.g. to attach an `onRoute` collector (spec 0009 RS1). Tests only. */
  readonly beforeInit?: (fastify: FastifyInstance) => void;
}

export async function createApp(config: AppConfig, overrides: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUSTED_PROXIES.length > 0 ? config.TRUSTED_PROXIES : false,
    genReqId: genRequestId,
    bodyLimit: 1_048_576, // 1 MiB; uploads go direct to object storage (docs/06 §9)
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config, overrides), adapter, {
    logger: config.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'],
  });
  const fastify = app.getHttpAdapter().getInstance();
  overrides.beforeInit?.(fastify);
  registerCsrfGuard(fastify);
  registerSecurityHeaders(fastify, { production: config.NODE_ENV === 'production' });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
