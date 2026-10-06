import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { HealthController } from './modules/health/health.controller.js';
import { AccessGuard } from './modules/identity/access.guard.js';
import { AuthController } from './modules/identity/auth.controller.js';
import { AuthService } from './modules/identity/auth.service.js';
import { MfaController } from './modules/identity/mfa.controller.js';
import { MfaService } from './modules/identity/mfa.service.js';
import { OneTimeCodeService } from './modules/identity/one-time-code.service.js';
import { PasswordAttempts } from './modules/identity/password-attempts.service.js';
import { SessionService } from './modules/identity/session.service.js';
import { UsersController } from './modules/identity/users.controller.js';
import { ProductDeclarationCheck } from './modules/products/product-declaration.check.js';
import { ProductGuard } from './modules/products/product.guard.js';
import { ProductService } from './modules/products/product.service.js';
import { ProductsController } from './modules/products/products.controller.js';
import { SettingsCache } from './modules/settings/settings-cache.js';
import { SettingsController } from './modules/settings/settings.controller.js';
import { SETTINGS_REGISTRY, SettingsService, settingsRegistryProvider, type SettingsRegistry } from './modules/settings/settings.service.js';
import { TenantProfileController } from './modules/tenant-profile/tenant-profile.controller.js';
import { AuditWriter } from './shared/audit/audit-writer.js';
import { DbModule } from './shared/db/db.module.js';
import { ProblemFilter } from './shared/errors/problem.filter.js';
import { RateLimiter, VALKEY } from './shared/infra/rate-limiter.js';
import { fieldCryptoProvider } from './shared/crypto/envelope.js';
import { Outbox } from './shared/outbox/outbox.js';
import { TenantGuard } from './shared/tenancy/tenant.guard.js';
import { TenantResolver } from './shared/tenancy/tenant-resolver.service.js';

export interface AppOverrides {
  /** Tests add setting keys to prove permission scoping (spec 0007 ST5). */
  readonly settingsRegistry?: SettingsRegistry;
  /** Tests only: the route sweep's deliberately leaky control routes (spec 0009 RS8). Never in main.ts. */
  readonly extraControllers?: readonly Type[];
  readonly extraProviders?: readonly Provider[];
}

@Module({})
export class AppModule {
  /** No email seam: the HTTP app has no mailer at all (spec 0002 B7). */
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule, DiscoveryModule],
      controllers: [HealthController, TenantProfileController, AuthController, MfaController, UsersController, ProductsController, SettingsController, ...(overrides.extraControllers ?? [])],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: VALKEY,
          useFactory: () =>
            new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 }),
        },
        TenantResolver,
        AuditWriter,
        fieldCryptoProvider,
        Outbox,
        RateLimiter,
        SessionService,
        OneTimeCodeService,
        PasswordAttempts,
        MfaService,
        AuthService,
        ProductService,
        ProductDeclarationCheck,
        SettingsCache,
        SettingsService,
        overrides.settingsRegistry ? { provide: SETTINGS_REGISTRY, useValue: overrides.settingsRegistry } : settingsRegistryProvider,
        // Guard order matters: resolve the tenant, hide inactive products (spec 0003 P3), then authenticate.
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: ProductGuard },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
        ...(overrides.extraProviders ?? []),
      ],
      exports: [APP_CONFIG],
    };
  }
}
