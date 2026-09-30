import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { HealthController } from './modules/health/health.controller.js';
import { TenantProfileController } from './modules/tenant-profile/tenant-profile.controller.js';
import { DbModule } from './shared/db/db.module.js';
import { ProblemFilter } from './shared/errors/problem.filter.js';
import { TenantGuard } from './shared/tenancy/tenant.guard.js';
import { TenantResolver } from './shared/tenancy/tenant-resolver.service.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule],
      controllers: [HealthController, TenantProfileController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        TenantResolver,
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [APP_CONFIG],
    };
  }
}
