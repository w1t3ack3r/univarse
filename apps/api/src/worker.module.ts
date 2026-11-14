import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ProductService } from './modules/products/product.service.js';
import { AuditWriter } from './shared/audit/audit-writer.js';
import { Redis } from 'ioredis';
import { fieldCryptoProvider, keyringProvider } from './shared/crypto/envelope.js';
import { RENEW_VAULT_TOKEN, VaultTokenRenewal } from './shared/crypto/token-renewal.js';
import { TenantSideRollupWriter } from './shared/db/security-rollup-writer.js';
import { SECURITY_ROLLUP_SOURCE } from './shared/observability/security-rollup.js';
import { KeyDestruction, KeyForgetListener } from './shared/crypto/key-forget.js';
import { BUS_SUBSCRIBE, InvalidationBus } from './shared/infra/invalidation-bus.js';
import { VALKEY } from './shared/infra/rate-limiter.js';
import { KeyMaintenance } from './shared/crypto/key-maintenance.js';
import { ClamdScanner } from './modules/files/clamd-scanner.js';
import { FileScanWorker } from './modules/files/file-scan.worker.js';
import { ContactBlanker } from './modules/identity/contact-blanker.js';
import { FileStorage } from './modules/files/file-storage.js';
import { createPlatformClient } from '@univarse/db';
import { DbModule } from './shared/db/db.module.js';
import { MAILER, SmtpMailer, type Mailer } from './shared/infra/mailer.js';
import { PlatformInvalidationRelay } from './shared/infra/platform-invalidation-relay.js';
import { shutdownHook } from './shared/observability/shutdown-hook.js';
import { OutboxWorker } from './shared/outbox/outbox-worker.js';
import { Outbox } from './shared/outbox/outbox.js';
import { keyProviderFrom, type KeyProvider } from '@univarse/crypto';
import { provisioningKeyFrom } from './shared/crypto/provisioning-key.js';
import { OnboardingCheck } from './modules/provisioning/onboarding-check.js';
import { SuspensionSessionEnding } from './modules/suspension/session-ending.js';
import { NoticeFanOut } from './modules/notices/notice-fan-out.js';
import { ProvisioningQueue } from './modules/provisioning/provisioning-queue.js';
import { PROVISIONING_OPEN_KEYS, ProvisioningRunner, TENANT_KEYS } from './modules/provisioning/provisioning-runner.js';

export interface WorkerOverrides {
  /** Tests capture outbound email instead of sending via SMTP. */
  readonly mailer?: Mailer;
  /** Runs last when the context closes: the worker process flushes its traces here (spec 0012 OB11). */
  readonly onShutdown?: () => Promise<void>;
  /** Spec 0015: the `keys` CLI publishes invalidations but never subscribes. Default: subscribe. */
  readonly subscribe?: boolean;
  /** Spec 0023 T2: keep the Vault token alive (renewed at start, then every 6 h). Only the real process sets it. */
  readonly renewVaultToken?: boolean;
  /** Spec 0031 Q9: count security events for the console. Only the real process sets it. */
  readonly recordSecurityEvents?: boolean;
  /**
   * Spec 0034 Q7: tests give the provisioning key directly; null leaves provisioning off. Otherwise it comes from the
   * worker's own settings (.env.worker), and the worker runs no provisioning without them.
   */
  readonly provisioningKeys?: KeyProvider | null;
  /** Tests: the tenant KEK provider for the key step, without Vault. */
  readonly tenantKeys?: KeyProvider;
  /** Tests: no waiting between a step's retries. */
  readonly provisioningRetryDelays?: readonly number[];
}

/**
 * The worker process (src/worker.ts): outbox delivery and the key sweep (spec 0006). It is the only
 * place a Mailer exists (spec 0002 B7). The `keys` CLI reuses it as its application context.
 */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, overrides: WorkerOverrides = {}): DynamicModule {
    return {
      module: WorkerModule,
      global: true,
      imports: [DbModule],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: MAILER,
          useValue: overrides.mailer ?? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM),
        },
        {
          provide: VALKEY,
          useFactory: () => {
            const r = new Redis(config.VALKEY_URL, {
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
              connectTimeout: 2_000,
            });
            // Reconnects by itself; a publish while it's down reports "unconfirmed" (spec 0015 CI6). Debug only.
            r.on('error', (err: Error) =>
              new Logger('Valkey').debug({ event: 'valkey.connection_error', error: err.name }),
            );
            return r;
          },
        },
        // The worker has no RateLimiter to close the Valkey client, so this does, at shutdown.
        {
          provide: 'VALKEY_CLOSE',
          inject: [VALKEY],
          useFactory: (r: Redis) => ({ onModuleDestroy: () => r.disconnect() }),
        },
        // Spec 0015: the invalidation bus (products for the outbox's checks, key forget for the keyring).
        { provide: BUS_SUBSCRIBE, useValue: overrides.subscribe ?? true },
        InvalidationBus,
        AuditWriter,
        keyringProvider,
        fieldCryptoProvider,
        { provide: RENEW_VAULT_TOKEN, useValue: overrides.renewVaultToken ?? false },
        VaultTokenRenewal,
        { provide: SECURITY_ROLLUP_SOURCE, useValue: overrides.recordSecurityEvents ? 'worker' : null },
        TenantSideRollupWriter,
        KeyForgetListener,
        KeyDestruction,
        ProductService,
        OutboxWorker,
        KeyMaintenance,
        FileStorage,
        ClamdScanner,
        FileScanWorker,
        ContactBlanker,
        // Spec 0034: the go-live checklist's administrator fact, always; provisioning itself only with its key.
        OnboardingCheck,
        // Spec 0037 Q7: a suspended institution's sessions end here, the only process with its credential.
        SuspensionSessionEnding,
        // Spec 0037 Q10: notices' emails to IT Admins (through each institution's outbox) and their delivery log.
        Outbox,
        NoticeFanOut,
        ...provisioningProviders(config, overrides),
        // Spec 0016: the platform invalidation relay, on its own role's connection. Only the worker process has
        // PLATFORM_RELAY_URL (loadConfig refuses it elsewhere), so the keys CLI never gets one.
        ...(config.PLATFORM_RELAY_URL ? [relayProvider(config.PLATFORM_RELAY_URL)] : []),
        ...(overrides.onShutdown ? [shutdownHook(overrides.onShutdown)] : []),
      ],
      exports: [APP_CONFIG],
    };
  }
}

function provisioningProviders(config: AppConfig, overrides: WorkerOverrides) {
  const inviteKeys = overrides.provisioningKeys !== undefined ? overrides.provisioningKeys : provisioningKeyFrom(config);
  if (!inviteKeys) return [];
  return [
    { provide: PROVISIONING_OPEN_KEYS, useValue: inviteKeys },
    { provide: TENANT_KEYS, useFactory: () => overrides.tenantKeys ?? keyProviderFrom(config) },
    { provide: 'PROVISIONING_RETRY_DELAYS', useValue: overrides.provisioningRetryDelays ?? [500, 2_000] },
    ProvisioningRunner,
    ProvisioningQueue,
  ];
}

function relayProvider(url: string) {
  return {
    provide: PlatformInvalidationRelay,
    inject: [InvalidationBus],
    useFactory: (bus: InvalidationBus) =>
      new PlatformInvalidationRelay(createPlatformClient(url), (channel, tenantId, timeoutMs) =>
        bus.publish(channel, tenantId, timeoutMs),
      ),
  };
}
