import { context, ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { storedContext } from '../observability/propagation.js';
import { MalformedOnce, withSpan } from '../observability/worker-spans.js';
import { withLogContext } from '../observability/context.js';
// Outbox delivery (spec 0002 B3–B10). Runs in the worker process only (src/worker.ts).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient, TenantTx } from '@univarse/db';
import { z } from 'zod';
import { FieldCrypto } from '@univarse/crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { ProductService } from '../../modules/products/product.service.js';
import { PLATFORM_DB, ShardRegistry } from '../db/db.module.js';
import { MAILER, type Mailer } from '../infra/mailer.js';
import { backoffMs, errorSummary, MAX_ATTEMPTS } from './delivery-policy.js';
import { EMAIL_EVENT, outboxAad } from './outbox.js';

const BATCH = 10;
/** Covers a full batch at the SMTP timeout; the row locks are what make the claim exclusive (B6). */
const TX_TIMEOUT_MS = 120_000;
/** Tenants whose events are delivered. Suspended tenants' events wait (design decisions). */
const SERVABLE = ['ACTIVE', 'ONBOARDING'] as const;

const EmailPayload = z.object({ to: z.string().min(3), subject: z.string(), text: z.string() });

export interface TenantRef {
  readonly id: string;
  readonly shardId: string;
}

export interface BatchCounts {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

interface ClaimedRow {
  id: string;
  type: string;
  payload_enc: string | null;
  attempts: number;
  traceparent: string | null;
}

@Injectable()
export class OutboxWorker {
  private readonly malformed = new MalformedOnce();
  private readonly logger = new Logger('Outbox');
  private readonly mailDomain: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly shards: ShardRegistry,
    private readonly products: ProductService,
    private readonly fieldCrypto: FieldCrypto,
  ) {
    this.mailDomain = /@([^>\s]+)/.exec(config.MAIL_FROM)?.[1] ?? 'univarse.localhost';
  }

  /** One pass over every servable tenant. Tenants are independent: one failing doesn't stop the rest. */
  async runOnce(): Promise<BatchCounts> {
    return withSpan('outbox.pass', {}, context.active(), async (span) => {
      const counts = await this.runPass();
      span.setAttribute('univarse.claimed', counts.claimed);
      return counts;
    });
  }

  private async runPass(): Promise<BatchCounts> {
    const total: BatchCounts = { claimed: 0, sent: 0, retried: 0, dead: 0 };
    const tenants = await this.platform.tenant.findMany({
      where: { status: { in: [...SERVABLE] } },
      select: { id: true, shardId: true },
    });
    for (const tenant of tenants) {
      try {
        // Spec 0012 OB2: lines from anything this tenant's batch calls carry its tenantId.
        // `span: undefined`: the pass spans every tenant, so it must not be tagged with one (OB8).
        const c = await withLogContext({ tenantId: tenant.id, span: undefined }, () => this.runTenant(tenant));
        for (const k of Object.keys(total) as (keyof BatchCounts)[]) total[k] += c[k];
      } catch (err) {
        this.logger.error({ event: 'outbox.tenant_failed', tenantId: tenant.id, error: errorSummary(err) }, 'Outbox pass failed for tenant');
      }
    }
    return total;
  }

  /**
   * B3/B6/B8/B10: claims one batch for one tenant under that tenant's RLS context, delivers it and
   * records the outcome in the same transaction. Events of inactive products aren't claimed.
   */
  async runTenant(tenant: TenantRef): Promise<BatchCounts> {
    const active = [...(await this.products.active(tenant.id))];
    const counts = await this.shards.tx(
      tenant.shardId,
      tenant.id,
      async (tx) => {
        const rows = await tx.$queryRaw<ClaimedRow[]>`
          SELECT id, type, payload_enc, attempts, traceparent FROM outbox_event
          WHERE tenant_id = ${tenant.id}::uuid AND status = 'PENDING' AND next_attempt_at <= now()
            AND product = ANY(${active}::text[])
          ORDER BY next_attempt_at, id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        const c: BatchCounts = { claimed: rows.length, sent: 0, retried: 0, dead: 0 };
        for (const row of rows) c[await this.deliverTraced(tx, tenant.id, row)]++;
        return c;
      },
      { timeoutMs: TX_TIMEOUT_MS },
    );
    // B9: counts only, never payloads or recipients.
    if (counts.claimed > 0) this.logger.log({ event: 'outbox.batch', tenantId: tenant.id, ...counts }, 'Outbox batch');
    return counts;
  }

  /**
   * Spec 0012 OB10: the delivery is a CHILD of the request that wrote the row (one trace, and the request's
   * sampling decision); a row without a valid context (older rows, tracing off, malformed) gets a fresh root.
   */
  private deliverTraced(tx: TenantTx, tenantId: string, row: ClaimedRow): Promise<'sent' | 'retried' | 'dead'> {
    const stored = storedContext(row.traceparent);
    if (stored.kind === 'malformed' && this.malformed.first(row.id)) {
      this.logger.warn({ event: 'outbox.traceparent_malformed', tenantId, eventId: row.id }, 'Stored trace context is malformed; delivering under a new trace');
    }
    const parent = stored.kind === 'valid' ? stored.context : ROOT_CONTEXT;
    const attributes = { 'univarse.outbox.event_id': row.id, 'univarse.outbox.type': row.type };
    return withSpan('outbox.deliver', { kind: SpanKind.CONSUMER, attributes }, parent, (span) =>
      withLogContext({ tenantId }, async () => {
        const outcome = await this.deliver(tx, tenantId, row);
        span.setAttribute('univarse.outbox.outcome', outcome);
        return outcome;
      }),
    );
  }

  private async deliver(tx: TenantTx, tenantId: string, row: ClaimedRow): Promise<'sent' | 'retried' | 'dead'> {
    const attempts = row.attempts + 1;
    try {
      if (row.type !== EMAIL_EVENT) throw Object.assign(new Error('unsupported'), { name: 'UnsupportedEventType' });
      if (!row.payload_enc) throw Object.assign(new Error('missing'), { name: 'MissingPayload' });
      const mail = EmailPayload.parse(JSON.parse((await this.fieldCrypto.decrypt(tenantId, row.payload_enc, outboxAad(tenantId, row.id))).toString('utf8')));
      // B6: stable Message-ID, so a re-send after a crash can be de-duplicated by the receiver.
      await this.mailer.send({ ...mail, messageId: `<${row.id}@${this.mailDomain}>` });
    } catch (err) {
      const dead = attempts >= MAX_ATTEMPTS;
      await tx.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: errorSummary(err),
          ...(dead ? { status: 'DEAD' } : { nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }),
        },
      });
      if (dead) this.logger.error({ event: 'outbox.event_dead', tenantId, eventId: row.id, error: errorSummary(err) }, 'Outbox event is DEAD');
      return dead ? 'dead' : 'retried';
    }
    // B2: the payload (which may hold a code) is wiped once delivered.
    await tx.outboxEvent.update({
      where: { id: row.id },
      data: { status: 'SENT', publishedAt: new Date(), attempts, lastError: null, payloadEnc: null },
    });
    return 'sent';
  }

  /** Polling loop for the worker process. Passes never overlap. */
  start(intervalMs: number): void {
    const tick = () => {
      this.running = this.runOnce()
        .catch((err: unknown) => this.logger.error({ event: 'outbox.pass_failed', error: errorSummary(err) }, 'Outbox pass failed'))
        .finally(() => {
          if (this.timer !== null) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Stops polling and waits for the current pass, so a shutdown never abandons a batch mid-send. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
