import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ProductService } from './modules/products/product.service.js';
import { AuditWriter } from './shared/audit/audit-writer.js';
import { Redis } from 'ioredis';
import { fieldCryptoProvider, keyringProvider } from './shared/crypto/envelope.js';
import { KeyDestruction, KeyForgetListener } from './shared/crypto/key-forget.js';
import { BUS_SUBSCRIBE, InvalidationBus } from './shared/infra/invalidation-bus.js';
import { VALKEY } from './shared/infra/rate-limiter.js';
import { KeyMaintenance } from './shared/crypto/key-maintenance.js';
import { ClamdScanner } from './modules/files/clamd-scanner.js';
import { FileScanWorker } from './modules/files/file-scan.worker.js';
import { FileStorage } from './modules/files/file-storage.js';
import { DbModule } from './shared/db/db.module.js';
import { MAILER, SmtpMailer, type Mailer } from './shared/infra/mailer.js';
import { shutdownHook } from './shared/observability/shutdown-hook.js';
import { OutboxWorker } from './shared/outbox/outbox-worker.js';

export interface WorkerOverrides {
  /** Tests capture outbound email instead of sending via SMTP. */
  readonly mailer?: Mailer;
  /** Runs last when the context closes: the worker process flushes its traces here (spec 0012 OB11). */
  readonly onShutdown?: () => Promise<void>;
  /** Spec 0015: the `keys` CLI publishes invalidations but never subscribes. Default: subscribe. */
  readonly subscribe?: boolean;
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
        KeyForgetListener,
        KeyDestruction,
        ProductService,
        OutboxWorker,
        KeyMaintenance,
        FileStorage,
        ClamdScanner,
        FileScanWorker,
        ...(overrides.onShutdown ? [shutdownHook(overrides.onShutdown)] : []),
      ],
      exports: [APP_CONFIG],
    };
  }
}
