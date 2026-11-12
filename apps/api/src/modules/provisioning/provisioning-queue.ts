// Spec 0034 Q2, Q3: provisioning's queue, in the worker. Postgres holds every state; BullMQ only schedules. The relay
// puts every job that should be running on the queue, with BullMQ's job id equal to the row's, so queuing one twice is
// harmless and a Valkey that lost everything loses nothing: the next pass queues the jobs again. One job at a time,
// in its own queue, so a slow provisioning never delays email, keys or scans.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../../shared/db/db.module.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { ProvisioningRunner } from './provisioning-runner.js';

export const PROVISIONING_QUEUE = 'platform-provisioning';
/** Its own key prefix in the shared Valkey: nothing else there can collide with the queue's keys. */
export const QUEUE_PREFIX = 'uv-bull';

@Injectable()
export class ProvisioningQueue {
  private readonly logger = new Logger('Provisioning');
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly runner: ProvisioningRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private open(): { queue: Queue; connection: Redis } {
    if (this.queue && this.connection) return { queue: this.queue, connection: this.connection };
    // BullMQ's blocking commands need `maxRetriesPerRequest: null` on its connection.
    this.connection = new Redis(this.config.VALKEY_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err: Error) => this.logger.debug({ event: 'provisioning.valkey_error', error: err.name }));
    this.queue = new Queue(PROVISIONING_QUEUE, { connection: this.connection, prefix: QUEUE_PREFIX });
    return { queue: this.queue, connection: this.connection };
  }

  /** One relay pass: queue every job that should be running. Returns how many it offered. */
  async relay(): Promise<number> {
    const jobs = await this.platform.provisioningJob.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (jobs.length === 0) return 0;
    const { queue } = this.open();
    await queue.addBulk(jobs.map((j) => ({ name: 'provision', data: { jobId: j.id }, opts: { jobId: j.id, removeOnComplete: true, removeOnFail: true } })));
    return jobs.length;
  }

  /** Starts the queue's consumer (one at a time) and the relay's loop. */
  start(): void {
    const { connection } = this.open();
    this.worker = new Worker(
      PROVISIONING_QUEUE,
      async (job) => {
        const jobId = (job.data as { jobId?: unknown }).jobId;
        // Q14: the queue carries an id and nothing else; the job row decides which tenant is touched.
        if (typeof jobId !== 'string' || jobId !== job.id) return;
        await this.runner.run(jobId);
      },
      { connection: connection.duplicate(), prefix: QUEUE_PREFIX, concurrency: 1, lockDuration: 120_000 },
    );
    this.worker.on('error', (err: Error) => this.logger.warn({ event: 'provisioning.queue_error', error: err.name }, 'The provisioning queue reported an error'));
    const interval = this.config.PROVISIONING_RELAY_INTERVAL_MS;
    if (interval <= 0) return;
    const tick = () => {
      this.running = backgroundPass(this.logger, 'provisioning.relay_failed', () => this.relay()).finally(() => {
        if (this.timer !== null) this.timer = setTimeout(tick, interval);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
    this.worker = null;
    this.queue = null;
    this.connection = null;
  }
}
