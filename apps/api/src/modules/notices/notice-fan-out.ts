// Spec 0037 Q10, Q11 (E12): a published notice's email to each institution's IT Admins, and the delivery log. The
// platform never knows an IT Admin's address (ADR-035), so the worker fans out per institution, in a queue of its own
// (`platform-notices`): one job per delivery, which on that institution's side writes one email per IT Admin into its
// outbox, named by the notice. Postgres holds every state; BullMQ only schedules (as provisioning, spec 0034 Q3): the
// relay queues each delivery not yet fanned out, with the job id derived from the row, so queuing twice is harmless.
// A slow or failing institution holds only its own job (invariant 11). A second pass keeps the counts: emails sent and
// failed, from the outbox, and banners dismissed. Counts only cross to the platform: never an address, name or id.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import type { NoticeKind } from '@univarse/domain';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { Outbox } from '../../shared/outbox/outbox.js';
import { QUEUE_PREFIX } from '../provisioning/provisioning-queue.js';
import { IT_ADMIN_PERMISSION } from './notice-board.service.js';

export const NOTICE_QUEUE = 'platform-notices';
/** How long after publishing a delivery's counts are kept up to date (the banner's longest life, and a day). */
export const COUNT_FOR_MS = 15 * 24 * 3_600_000;

const LABEL: Record<NoticeKind, string> = { MAINTENANCE: 'Planned maintenance', ANNOUNCEMENT: 'An announcement', RELEASE_NOTE: 'A release note' };
const day = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const time = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });

export interface NoticeMail {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

/** The email, as plain text: the notice exactly as written, with what it is and why this person got it. */
export function noticeEmail(n: NoticeMail, institution: string): { subject: string; text: string } {
  const window = n.kind === 'MAINTENANCE' && n.startsAt && n.endsAt ? `When: ${day.format(n.startsAt)}, ${time.format(n.startsAt)} to ${day.format(n.endsAt)}, ${time.format(n.endsAt)} (Nigerian time)\n\n` : '';
  return {
    // One line, always (the domain refuses line breaks in a title; this holds even if one got through).
    subject: `UniVarse: ${n.title.replace(/\s+/g, ' ').trim()}`,
    text:
      `${LABEL[n.kind]} from UniVarse for ${institution}.\n\n` +
      `${n.title}\n\n${window}${n.body}\n\n` +
      `You're getting this because you're an IT Admin for ${institution} on UniVarse. It's also shown in your workspace.`,
  };
}

const jobId = (noticeId: string, tenantId: string) => `${noticeId}_${tenantId}`;

@Injectable()
export class NoticeFanOut {
  private readonly logger = new Logger('Notices');
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly outbox: Outbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * One delivery: the institution's IT Admins (active, with an address, holding the permission now) each get one email in
   * its outbox, in one transaction. Run again after a crash, it finds the emails already there and adds none.
   */
  async fanOut(noticeId: string, tenantId: string): Promise<{ itAdmins: number; queued: number } | null> {
    const d = await this.platform.platformNoticeDelivery.findUnique({
      where: { noticeId_tenantId: { noticeId, tenantId } },
      select: {
        fannedOutAt: true,
        withdrawnAt: true,
        notice: { select: { kind: true, title: true, body: true, startsAt: true, endsAt: true, status: true } },
        tenant: { select: { shardId: true, legalName: true } },
      },
    });
    // Withdrawn before it went out: nobody is emailed about a notice that's gone. Recorded as nobody reached.
    if (!d || d.fannedOutAt) return null;
    const out = d.withdrawnAt || d.notice.status !== 'PUBLISHED' ? { itAdmins: 0, queued: 0 } : await this.write(noticeId, tenantId, d.tenant, d.notice);
    await this.platform.platformNoticeDelivery.updateMany({
      where: { noticeId, tenantId, fannedOutAt: null },
      data: { fannedOutAt: new Date(), itAdmins: out.itAdmins, emailsQueued: out.queued },
    });
    return out;
  }

  private write(noticeId: string, tenantId: string, tenant: { shardId: string; legalName: string }, notice: NoticeMail) {
    const now = new Date();
    return this.shards.tx(tenant.shardId, tenantId, async (tx) => {
      const admins = await tx.userAccount.findMany({
        where: {
          status: 'ACTIVE',
          email: { not: null },
          roleAssignments: { some: { revokedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], role: { permissions: { has: IT_ADMIN_PERMISSION } } } },
        },
        select: { email: true },
      });
      const already = await tx.outboxEvent.count({ where: { noticeId } });
      if (already > 0) return { itAdmins: admins.length, queued: Math.min(already, admins.length) };
      const mail = noticeEmail(notice, tenant.legalName);
      for (const a of admins) if (a.email) await this.outbox.enqueueEmail(tx, tenantId, { to: a.email, ...mail }, 'core', { noticeId });
      return { itAdmins: admins.length, queued: admins.length };
    });
  }

  /** Q11: a delivery's counts, from the institution's own records: emails sent and failed, banners dismissed. */
  async count(noticeId: string, tenantId: string, shardId: string): Promise<void> {
    const c = await this.shards.tx(shardId, tenantId, async (tx) => {
      const [sent, failed, dismissed] = await Promise.all([
        tx.outboxEvent.count({ where: { noticeId, status: 'SENT' } }),
        tx.outboxEvent.count({ where: { noticeId, status: 'DEAD' } }),
        tx.noticeDismissal.count({ where: { noticeId } }),
      ]);
      return { sent, failed, dismissed };
    });
    await this.platform.platformNoticeDelivery.updateMany({
      where: { noticeId, tenantId, fannedOutAt: { not: null } },
      data: { emailsSent: c.sent, emailsFailed: c.failed, bannersDismissed: c.dismissed, countedAt: new Date() },
    });
  }

  /** One relay pass: queue every delivery not yet fanned out. Returns how many it offered. */
  async relay(): Promise<number> {
    const pending = await this.platform.platformNoticeDelivery.findMany({ where: { fannedOutAt: null }, select: { noticeId: true, tenantId: true }, orderBy: { createdAt: 'asc' }, take: 500 });
    if (pending.length === 0) return 0;
    const { queue } = this.open();
    await queue.addBulk(pending.map((d) => ({ name: 'fan-out', data: { noticeId: d.noticeId, tenantId: d.tenantId }, opts: { jobId: jobId(d.noticeId, d.tenantId), removeOnComplete: true, removeOnFail: true } })));
    return pending.length;
  }

  /** One counting pass over the deliveries still worth counting. One institution's failure doesn't hold the others. */
  async countPass(now = new Date()): Promise<void> {
    const rows = await this.platform.platformNoticeDelivery.findMany({
      where: { fannedOutAt: { not: null }, createdAt: { gt: new Date(now.getTime() - COUNT_FOR_MS) } },
      select: { noticeId: true, tenantId: true, tenant: { select: { shardId: true } } },
    });
    let failed = 0;
    for (const r of rows) {
      try {
        await this.count(r.noticeId, r.tenantId, r.tenant.shardId);
      } catch (err) {
        failed += 1;
        this.logger.warn({ event: 'notices.count_failed', tenantId: r.tenantId, error: err instanceof Error ? err.name : 'unknown' }, 'Counting a notice’s delivery failed; the next pass tries again');
      }
    }
    if (failed) throw new Error(`${String(failed)} delivery count(s) failed`);
  }

  private open(): { queue: Queue; connection: Redis } {
    if (this.queue && this.connection) return { queue: this.queue, connection: this.connection };
    this.connection = new Redis(this.config.VALKEY_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err: Error) => this.logger.debug({ event: 'notices.valkey_error', error: err.name }));
    this.queue = new Queue(NOTICE_QUEUE, { connection: this.connection, prefix: QUEUE_PREFIX });
    return { queue: this.queue, connection: this.connection };
  }

  /** Starts the queue's consumer, the relay's loop and the counting loop. */
  start(): void {
    const { connection } = this.open();
    this.worker = new Worker(
      NOTICE_QUEUE,
      async (job) => {
        const { noticeId, tenantId } = job.data as { noticeId?: unknown; tenantId?: unknown };
        // The queue carries ids and nothing else; the delivery row decides what is sent, and to which institution.
        if (typeof noticeId !== 'string' || typeof tenantId !== 'string' || job.id !== jobId(noticeId, tenantId)) return;
        await this.fanOut(noticeId, tenantId);
      },
      { connection: connection.duplicate(), prefix: QUEUE_PREFIX, concurrency: 4 },
    );
    this.worker.on('error', (err: Error) => this.logger.warn({ event: 'notices.queue_error', error: err.name }, 'The notices queue reported an error'));
    this.loop(this.config.NOTICE_RELAY_INTERVAL_MS, 'notices.relay_failed', () => this.relay());
    this.loop(this.config.NOTICE_COUNT_INTERVAL_MS, 'notices.count_pass_failed', () => this.countPass());
  }

  private loop(intervalMs: number, event: string, fn: () => Promise<unknown>): void {
    if (intervalMs <= 0) return;
    const tick = () => {
      const run: Promise<unknown> = backgroundPass(this.logger, event, fn).finally(() => {
        this.running.delete(run);
        if (!this.stopped) this.timers.push(setTimeout(tick, intervalMs));
      });
      this.running.add(run);
    };
    this.timers.push(setTimeout(tick, 0));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    await Promise.all([...this.running]);
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
    this.worker = null;
    this.queue = null;
    this.connection = null;
  }
}
