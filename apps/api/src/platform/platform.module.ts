import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { KeyProvider } from '@univarse/crypto';
import { createPlatformClient } from '@univarse/db';
import { ProblemFilter } from '../shared/errors/problem.filter.js';
import { SmtpMailer, type Mailer } from '../shared/infra/mailer.js';
import { shutdownHook } from '../shared/observability/shutdown-hook.js';
import { PlatformAccessGuard } from './identity/access.js';
import { CONSOLE_KEYS, PlatformCredentials } from './identity/credentials.js';
import { PlatformAccountController, PlatformAuthController, PlatformStaffController } from './identity/identity.controller.js';
import { PlatformContact } from './identity/contact.service.js';
import { PlatformIdentity } from './identity/identity.service.js';
import { PLATFORM_MAILER, PlatformMailRelay } from './identity/mail.js';
import { PlatformSessions } from './identity/sessions.js';
import { PlatformStaff } from './identity/staff.service.js';
import { CONSOLE_DB, consoleKeyProvider, PLATFORM_CONFIG, type PlatformConfig } from './platform-config.js';
import { PlatformHealthController } from './platform-health.controller.js';
import { PlatformTenantsController } from './registry/tenant-registry.controller.js';
import { TenantRegistry } from './registry/tenant-registry.service.js';
import { ConsoleTokenRenewal, RENEW_CONSOLE_TOKEN } from './token-renewal.js';
import { PlatformAccessReviews } from './observe/access-review.js';
import { ConsoleRollupWriter } from './observe/console-rollup-writer.js';
import { PlatformAuditLog } from './observe/audit-log.js';
import { ChainVerification } from './observe/chain-verification.js';
import { PlatformAccessReviewController, PlatformAuditController, PlatformSecurityController } from './observe/observe.controller.js';
import { PlatformSecurityView } from './observe/security-view.js';
import { SECURITY_ROLLUP_SOURCE } from '../shared/observability/security-rollup.js';

/**
 * Every production controller of the platform API (spec 0027 P1), each under `/api/platform/v1` but health. None of
 * these is ever in the tenant API's `API_CONTROLLERS`, and the reverse (a test). S2 adds sign-in, the account and staff.
 */
export const PLATFORM_CONTROLLERS = [
  PlatformHealthController,
  PlatformAuthController,
  PlatformAccountController,
  PlatformStaffController,
  PlatformTenantsController,
  PlatformAuditController,
  PlatformSecurityController,
  PlatformAccessReviewController,
] as const;

export interface PlatformOverrides {
  /** Tests only: controllers that exercise the walls (a route under /api/platform/v1). Never in platform.ts. */
  readonly extraControllers?: readonly Type[];
  readonly extraProviders?: readonly Provider[];
  /** Tests only: a mailer that records instead of sending, and a key provider without Vault. */
  readonly mailer?: Mailer;
  readonly keys?: KeyProvider;
  readonly onShutdown?: () => Promise<void>;
  /** Spec 0028 Q3: keep the console's Vault token alive (renewed at start, then every 6 h). Only platform.ts sets it. */
  readonly renewVaultToken?: boolean;
  /** Spec 0031 Q9: count security events for the console. Only platform.ts sets it. */
  readonly recordSecurityEvents?: boolean;
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
        { provide: CONSOLE_KEYS, useFactory: () => overrides.keys ?? consoleKeyProvider(config) },
        { provide: PLATFORM_MAILER, useFactory: () => overrides.mailer ?? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) },
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Spec 0028 Q12: deny by default; every route's declaration is read here.
        { provide: APP_GUARD, useClass: PlatformAccessGuard },
        PlatformSessions,
        PlatformCredentials,
        PlatformIdentity,
        TenantRegistry,
        PlatformContact,
        PlatformStaff,
        PlatformMailRelay,
        { provide: RENEW_CONSOLE_TOKEN, useValue: overrides.renewVaultToken ?? false },
        ConsoleTokenRenewal,
        { provide: SECURITY_ROLLUP_SOURCE, useValue: overrides.recordSecurityEvents ? 'platform-api' : null },
        ConsoleRollupWriter,
        PlatformAuditLog,
        ChainVerification,
        PlatformSecurityView,
        PlatformAccessReviews,
        ...(overrides.extraProviders ?? []),
        ...(overrides.onShutdown ? [shutdownHook(overrides.onShutdown)] : []),
      ],
    };
  }
}
