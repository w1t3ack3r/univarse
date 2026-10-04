import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ProductService } from './modules/products/product.service.js';
import { AuditWriter } from './shared/audit/audit-writer.js';
import { DbModule } from './shared/db/db.module.js';
import { MAILER, SmtpMailer, type Mailer } from './shared/infra/mailer.js';
import { OutboxWorker } from './shared/outbox/outbox-worker.js';

export interface WorkerOverrides {
  /** Tests capture outbound email instead of sending via SMTP. */
  readonly mailer?: Mailer;
}

/** The worker process (src/worker.ts). It is the only place a Mailer exists (spec 0002 B7). */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, overrides: WorkerOverrides = {}): DynamicModule {
    return {
      module: WorkerModule,
      global: true,
      imports: [DbModule],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MAILER, useValue: overrides.mailer ?? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) },
        AuditWriter,
        ProductService,
        OutboxWorker,
      ],
      exports: [APP_CONFIG],
    };
  }
}
