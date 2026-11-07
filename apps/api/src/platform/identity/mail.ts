// Spec 0028 Q4: the console's mail. A message is written to platform_mail_outbox in the transaction of the action it
// reports (with its audit row), and this process's own relay sends it: at least once, each with a stable message id.
// The tenant worker is never involved (T28). A sent message's body is cleared: it may have held a one-time code.
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { backgroundPass } from '../../shared/observability/background.js';
import { securityFields } from '../../shared/observability/security.js';
import type { Mailer } from '../../shared/infra/mailer.js';
import { CONSOLE_DB, PLATFORM_CONFIG, type PlatformConfig } from '../platform-config.js';
import type { PlatformTx } from './types.js';

export const PLATFORM_MAILER = Symbol('PLATFORM_MAILER');

const MAX_ATTEMPTS = 8;
const BATCH = 10;
/** 30 s, 1 min, 2 min … up to an hour between attempts. */
const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

export interface PlatformMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Writes a message inside the caller's transaction: it is sent only if the action commits. */
export async function enqueueMail(tx: PlatformTx, mail: PlatformMail): Promise<void> {
  await tx.platformMailOutbox.create({ data: { toAddress: mail.to, subject: `UniVarse platform: ${mail.subject}`, body: mail.text } });
}

/** The closing every console message carries: what to do if it wasn't you. */
export const NOT_YOU = '\n\nIf this was not you, tell another platform owner at once.';

@Injectable()
export class PlatformMailRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PlatformMail');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    @Inject(PLATFORM_MAILER) private readonly mailer: Mailer,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.MAIL_RELAY_INTERVAL_MS === 0) return;
    // Spec 0031 Q10: a failed pass ends in its log line; the outbox still holds the mail, so the next tick retries.
    this.timer = setInterval(() => void backgroundPass(this.logger, 'platform.mail.pass_failed', () => this.drain()), this.config.MAIL_RELAY_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined); // a failing pass has been logged by its tick
  }

  /** One pass; never overlaps another. Returns how many were sent. */
  drain(): Promise<number> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<number> {
    let sent = 0;
    for (;;) {
      const done = await this.db.$transaction(async (tx) => {
        // Claimed under row locks; a second relay (none today) would skip them rather than send twice.
        const due = await tx.$queryRaw<{ id: string; to_address: string; subject: string; body: string; attempts: number }[]>`
          SELECT id, to_address, subject, body, attempts FROM platform_mail_outbox
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
        for (const m of due) {
          try {
            await this.mailer.send({ to: m.to_address, subject: m.subject, text: m.body, messageId: `<${m.id}@console.univarse>` });
            await tx.platformMailOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), body: '', lastError: null } });
            sent += 1;
          } catch (err) {
            const attempts = m.attempts + 1;
            const failed = attempts >= MAX_ATTEMPTS;
            await tx.platformMailOutbox.update({
              where: { id: m.id },
              data: { attempts, status: failed ? 'FAILED' : 'PENDING', nextAttemptAt: new Date(Date.now() + backoffMs(attempts)), lastError: String(err instanceof Error ? err.message : err).slice(0, 300), ...(failed ? { body: '' } : {}) },
            });
            if (failed) this.logger.error(securityFields('platform.mail.failed', { mailId: m.id, attempts }), 'Console mail could not be delivered');
          }
        }
        return due.length < BATCH;
      });
      if (done) return sent;
    }
  }
}
