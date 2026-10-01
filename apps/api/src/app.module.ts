import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { HealthController } from './modules/health/health.controller.js';
import { AccessGuard } from './modules/identity/access.guard.js';
import { AuthController } from './modules/identity/auth.controller.js';
import { AuthService } from './modules/identity/auth.service.js';
import { MfaController } from './modules/identity/mfa.controller.js';
import { MfaService } from './modules/identity/mfa.service.js';
import { OneTimeCodeService } from './modules/identity/one-time-code.service.js';
import { SessionService } from './modules/identity/session.service.js';
import { UsersController } from './modules/identity/users.controller.js';
import { TenantProfileController } from './modules/tenant-profile/tenant-profile.controller.js';
import { DbModule } from './shared/db/db.module.js';
import { ProblemFilter } from './shared/errors/problem.filter.js';
import { MAILER, SmtpMailer, type Mailer } from './shared/infra/mailer.js';
import { RateLimiter, VALKEY } from './shared/infra/rate-limiter.js';
import { TenantGuard } from './shared/tenancy/tenant.guard.js';
import { TenantResolver } from './shared/tenancy/tenant-resolver.service.js';

export interface AppOverrides {
  /** Tests capture outbound email instead of sending via SMTP. */
  readonly mailer?: Mailer;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule],
      controllers: [HealthController, TenantProfileController, AuthController, MfaController, UsersController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: VALKEY,
          useFactory: () =>
            new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 }),
        },
        { provide: MAILER, useValue: overrides.mailer ?? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) },
        TenantResolver,
        RateLimiter,
        SessionService,
        OneTimeCodeService,
        MfaService,
        AuthService,
        // Guard order matters: resolve the tenant first, then authenticate against it.
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [APP_CONFIG],
    };
  }
}
