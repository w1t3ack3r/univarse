import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createPlatformClient } from '@univarse/db';
import { ProblemFilter } from '../shared/errors/problem.filter.js';
import { shutdownHook } from '../shared/observability/shutdown-hook.js';
import { CONSOLE_DB, PLATFORM_CONFIG, type PlatformConfig } from './platform-config.js';
import { PlatformHealthController } from './platform-health.controller.js';

/**
 * Every production controller of the platform API (spec 0027 P1). S1 has health only; each later slice adds its own
 * under `/api/platform/v1`. None of these is ever in the tenant API's `API_CONTROLLERS`, and the reverse (a test).
 */
export const PLATFORM_CONTROLLERS = [PlatformHealthController] as const;

export interface PlatformOverrides {
  /** Tests only: controllers that exercise the walls (a route under /api/platform/v1). Never in platform.ts. */
  readonly extraControllers?: readonly Type[];
  readonly extraProviders?: readonly Provider[];
  readonly onShutdown?: () => Promise<void>;
}

@Module({})
export class PlatformModule {
  static forRoot(config: PlatformConfig, overrides: PlatformOverrides = {}): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      controllers: [...PLATFORM_CONTROLLERS, ...(overrides.extraControllers ?? [])],
      providers: [
        { provide: PLATFORM_CONFIG, useValue: config },
        { provide: CONSOLE_DB, useFactory: () => createPlatformClient(config.CONSOLE_DATABASE_URL) },
        { provide: APP_FILTER, useClass: ProblemFilter },
        ...(overrides.extraProviders ?? []),
        ...(overrides.onShutdown ? [shutdownHook(overrides.onShutdown)] : []),
      ],
    };
  }
}
