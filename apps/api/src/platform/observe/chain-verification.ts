// Spec 0031 Q5, Q6, Q7: verifying the platform audit chain, in the background, one run at a time, started by a member
// or by the schedule every 24 hours. Each run is recorded, and the last passing run's head is what the next run checks
// is still there. A broken chain logs a security event and stays visible until a later run passes; it changes nothing
// and blocks nothing: a person decides (invariant 12).
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { platformAuditPages, walkPlatformAuditChain, type PlatformChainHead } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { ProblemError } from '../../shared/errors/problem.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { securityFields } from '../../shared/observability/security.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB, PLATFORM_CONFIG, type PlatformConfig } from '../platform-config.js';

export const VERIFY_EVERY_MS = 24 * 60 * 60_000;

interface Run {
  id: string;
  trigger: 'MEMBER' | 'SCHEDULE';
  startedBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR';
  rowsChecked: bigint;
  headSeq: bigint | null;
  brokenAtSeq: bigint | null;
  reason: string | null;
}

@Injectable()
export class ChainVerification implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AuditChain');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.AUDIT_VERIFY_CHECK_INTERVAL_MS;
    if (every === 0) return;
    this.timer = setInterval(() => void backgroundPass(this.logger, 'platform.audit.schedule_failed', () => this.startIfDue()), every);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** The daily run, unless one finished in the last 24 hours or one is under way. */
  async startIfDue(now = new Date()): Promise<void> {
    if (this.running) return;
    const last = await this.db.platformAuditVerification.findFirst({ where: { status: { in: ['PASSED', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    if (last && now.getTime() - last.startedAt.getTime() < VERIFY_EVERY_MS) return;
    await this.start(null);
  }

  /** Starts a run and returns it at once; it finishes in the background. */
  async start(actor: PlatformActor | null, meta?: RequestMeta): Promise<Run> {
    if (this.running) throw new ProblemError(409, 'audit.verification_running', 'A verification is already running');
    // A run the process died in the middle of would otherwise read as running for ever.
    await this.db.platformAuditVerification.updateMany({ where: { status: 'RUNNING' }, data: { status: 'ERROR', finishedAt: new Date(), reason: 'interrupted' } });
    const run = await this.db.platformAuditVerification.create({ data: { trigger: actor ? 'MEMBER' : 'SCHEDULE', startedBy: actor?.userId ?? null } });
    this.running = backgroundPass(this.logger, 'platform.audit.verification_failed', () => this.run(run.id, actor, meta)).finally(() => {
      this.running = null;
    });
    return run;
  }

  /** Resolves when the current run, if any, has finished. */
  finished(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async knownHead(): Promise<PlatformChainHead | null> {
    const last = await this.db.platformAuditVerification.findFirst({ where: { status: 'PASSED', headSeq: { not: null } }, orderBy: { startedAt: 'desc' }, select: { headSeq: true, headHash: true } });
    return last?.headSeq != null && last.headHash ? { seq: last.headSeq, hash: last.headHash } : null;
  }

  private async run(id: string, actor: PlatformActor | null, meta?: RequestMeta): Promise<void> {
    try {
      let reported = Promise.resolve();
      const result = await walkPlatformAuditChain(platformAuditPages(this.db), {
        knownHead: await this.knownHead(),
        onProgress: (count) => {
          reported = reported.then(async () => {
            await this.db.platformAuditVerification.update({ where: { id }, data: { rowsChecked: count } });
          });
        },
      });
      await reported;
      await this.db.$transaction(async (tx) => {
        await tx.platformAuditVerification.update({
          where: { id },
          data: result.ok
            ? { status: 'PASSED', finishedAt: new Date(), rowsChecked: result.count, headSeq: result.head?.seq ?? null, headHash: result.head ? Buffer.from(result.head.hash) : null }
            : { status: 'FAILED', finishedAt: new Date(), rowsChecked: result.count, brokenAtSeq: result.brokenAtSeq, reason: result.reason },
        });
        await platformAudit(
          tx,
          {
            actorId: actor?.userId ?? null,
            action: 'platform.audit.verified',
            metadata: { runId: id, result: result.ok ? 'passed' : 'failed', rows: result.count, ...(result.ok ? {} : { brokenAtSeq: result.brokenAtSeq.toString(), reason: result.reason }) },
          },
          meta,
        );
      });
      if (!result.ok) this.logger.error(securityFields('platform.audit.chain_broken', { brokenAtSeq: result.brokenAtSeq.toString(), reason: result.reason }), 'The audit chain failed verification');
    } catch (err) {
      // The run couldn't finish, which says nothing about the chain.
      await this.db.platformAuditVerification.update({ where: { id }, data: { status: 'ERROR', finishedAt: new Date(), reason: 'could_not_finish' } });
      throw err;
    }
  }

  /** Runs as the API shows them: ids and bigints as strings, the starter's name joined at read time. */
  async named(runs: readonly Run[]) {
    const ids = [...new Set(runs.flatMap((r) => (r.startedBy ? [r.startedBy] : [])))];
    const members = ids.length ? await this.db.platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
    const names = new Map(members.map((m) => [m.id, m.displayName]));
    return runs.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      startedBy: r.startedBy ? { id: r.startedBy, name: names.get(r.startedBy) ?? null } : null,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status,
      rowsChecked: r.rowsChecked.toString(),
      headSeq: r.headSeq?.toString() ?? null,
      brokenAtSeq: r.brokenAtSeq?.toString() ?? null,
      reason: r.reason,
    }));
  }

  async recent(limit = 10) {
    const runs = await this.db.platformAuditVerification.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
    const verdict = await this.db.platformAuditVerification.findFirst({ where: { status: { in: ['PASSED', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, select: { status: true } });
    return { runs, broken: verdict?.status === 'FAILED' };
  }
}
