// Spec 0016 (ADR-031): publishes the platform invalidation events that the capture triggers write in the same
// transaction as each change to tenant, tenant_domain or tenant_product. Runs in the worker only, on the relay
// role's own connection (univarse_relay_platform: SELECT and four UPDATE columns on the event table, nothing else).
//   claim (FOR UPDATE SKIP LOCKED, cutoff statement_timestamp()) → touch (the guard stamps first_observed_at)
//   → expire (D6; the guard enforces the bound) → coalesce → publish until the 2 s deadline → record → commit.
// A crash before the commit leaves every claimed event PENDING, so delivery is at least once (IO8, IO9).
import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { CHANNELS, type Channel, type PublishResult } from './invalidation-bus.js';
import {
  BATCH_DEADLINE_MS,
  classifyFailure,
  coalesce,
  failureLabel,
  publishBudgetMs,
  PURGE_BATCH,
  PURGE_INTERVAL_MS,
  RELAY_BATCH,
  RELAY_POLL_MS,
  RELAY_TX_TIMEOUT_MS,
  relayBackoffMs,
} from './relay-policy.js';

export type PublishFn = (
  channel: Channel,
  tenantId: string,
  timeoutMs: number,
) => Promise<PublishResult>;

/** How a pass ended: everything claimed was handled, the deadline stopped it, or a publish failed. */
export type PassEnd = 'done' | 'deadline' | 'failure';

export interface RelayPass {
  readonly claimed: number;
  readonly expired: number;
  /** Events settled PUBLISHED by this pass (counted once its transaction commits). */
  readonly published: number;
  /** Successful publishes (one per coalesced pair). */
  readonly publishes: number;
  /** Publishes that timed out on a clipped budget: they may have been delivered (IO11's D). */
  readonly possibleDuplicates: number;
  /** Events given attempts + 1 and a backoff. */
  readonly retried: number;
  readonly end: PassEnd;
  /** From the claim to the end of its bookkeeping (just before the commit), on the relay's clock. */
  readonly durationMs: number;
}

/** Test seams (spec 0016 PR A decision 4). Production passes none. */
export interface RelayOptions {
  /** Monotonic milliseconds. Default performance.now(). */
  readonly now?: () => number;
  /** [0, 1] for the backoff's jitter. */
  readonly random?: () => number;
  /** Runs inside the transaction, after BEGIN and before the claim (IO12's paused relay). */
  readonly afterBegin?: () => void | Promise<void>;
  /** Runs after the claim, touch and expiry, before any publish (IO8). */
  readonly afterClaim?: (eventIds: readonly string[]) => void | Promise<void>;
  /** Runs after every publish and its bookkeeping, before the commit (IO9). */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Called by the polling loop after each committed pass, with the delay before the next one. */
  readonly onPass?: (pass: RelayPass, nextDelayMs: number) => void;
}

interface ClaimRow {
  id: string;
  channel: string;
  tenantId: string;
  attempts: number;
}

const KNOWN_CHANNELS: readonly string[] = [CHANNELS.tenants, CHANNELS.products];
const isChannel = (c: string): c is Channel => KNOWN_CHANNELS.includes(c);
/** The loop's wait after a pass that threw (the database unreachable): doubling from the poll, at most 5 s. */
const ERROR_BACKOFF_CAP_MS = 5_000;

export class PlatformInvalidationRelay implements OnApplicationShutdown {
  private readonly logger = new Logger('InvalidationRelay');
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private lastPurge = Number.NEGATIVE_INFINITY;
  private consecutiveErrors = 0;

  constructor(
    private readonly db: PlatformClient,
    private readonly publish: PublishFn,
    private readonly options: RelayOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  /** One pass: claim, publish and record in one platform transaction (IO7). Throws if the transaction fails. */
  async runOnce(): Promise<RelayPass> {
    const o = this.options;
    return this.db.$transaction(
      async (tx) => {
        await o.afterBegin?.();
        const start = this.now();
        const deadline = start + BATCH_DEADLINE_MS;
        // statement_timestamp(), not now(): this transaction may have begun before a commit it can now see, and a
        // fresh event's due time is its insert's clock_timestamp() (IO12).
        const rows = await tx.$queryRaw<ClaimRow[]>`
          SELECT id, channel, tenant_id AS "tenantId", attempts FROM public.cache_invalidation_event
          WHERE status = 'PENDING' AND next_attempt_at <= statement_timestamp()
          ORDER BY next_attempt_at, id
          LIMIT ${RELAY_BATCH}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return this.pass({ claimed: 0, end: 'done', start });
        const ids = rows.map((r) => r.id);
        // The touch: the update guard stamps first_observed_at (clock_timestamp(), once) on each claimed event.
        await tx.$executeRaw`UPDATE public.cache_invalidation_event SET attempts = attempts WHERE id = ANY(${ids}::uuid[])`;
        // D6: expire what has waited past first observation + the shared maximum + 5 s. The database's own bound;
        // the guard refuses anything earlier, whoever asks.
        const expired = await tx.$queryRaw<{ id: string }[]>`
          UPDATE public.cache_invalidation_event SET status = 'EXPIRED'
          WHERE id = ANY(${ids}::uuid[])
            AND clock_timestamp() >= first_observed_at + public.cache_invalidation_max_ttl() + interval '5 seconds'
          RETURNING id`;
        const expiredIds = new Set(expired.map((r) => r.id));
        await o.afterClaim?.(ids);

        const publications = coalesce(rows.filter((r) => !expiredIds.has(r.id)));
        const published: string[] = [];
        let publishes = 0;
        let possibleDuplicates = 0;
        let end: PassEnd = 'done';
        let failed: { from: number; label: string } | null = null;
        for (const [i, p] of publications.entries()) {
          const budget = publishBudgetMs(deadline, this.now());
          if (budget <= 0) {
            end = 'deadline';
            break;
          }
          if (!isChannel(p.channel)) throw new Error('Unknown invalidation channel');
          const result = await this.publish(p.channel, p.tenantId, budget);
          if (result.delivered) {
            published.push(...p.eventIds);
            publishes++;
            continue;
          }
          if (classifyFailure(result.reason, budget) === 'deadline') {
            // Deadline exhaustion: those events stay as they are, and the next pass claims them at once.
            end = 'deadline';
            possibleDuplicates++;
          } else {
            end = 'failure';
            failed = { from: i, label: failureLabel(result.reason) };
          }
          break;
        }

        if (published.length > 0)
          await tx.$executeRaw`
            UPDATE public.cache_invalidation_event SET status = 'PUBLISHED', last_error = NULL
            WHERE id = ANY(${published}::uuid[])`;
        let retried = 0;
        if (failed) {
          const attemptsById = new Map(rows.map((r) => [r.id, r.attempts]));
          const retry = publications.slice(failed.from).flatMap((p) => p.eventIds);
          const delays = retry.map((id) =>
            relayBackoffMs((attemptsById.get(id) ?? 0) + 1, o.random),
          );
          retried = retry.length;
          await tx.$executeRaw`
            UPDATE public.cache_invalidation_event AS e
            SET attempts = e.attempts + 1, next_attempt_at = clock_timestamp() + d.ms * interval '1 millisecond',
                last_error = ${failed.label}
            FROM unnest(${retry}::uuid[], ${delays}::int[]) AS d(id, ms)
            WHERE e.id = d.id`;
        }
        await o.beforeCommit?.();
        return this.pass({
          claimed: rows.length,
          expired: expiredIds.size,
          published: published.length,
          publishes,
          possibleDuplicates,
          retried,
          end,
          start,
        });
      },
      { timeout: RELAY_TX_TIMEOUT_MS },
    );
  }

  /** IO18: deletes up to 1 000 events settled for more than 24 h, at most once a minute. */
  async housekeep(): Promise<number | null> {
    if (this.now() - this.lastPurge < PURGE_INTERVAL_MS) return null;
    this.lastPurge = this.now();
    const [row] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT public.purge_settled_invalidation_events(${PURGE_BATCH}::int) AS n`;
    const n = row?.n ?? 0;
    if (n > 0)
      this.logger.log(
        { event: 'cache.invalidation.purged', count: n },
        'Purged settled invalidation events',
      );
    return n;
  }

  /** D4: polls every 250 ms when idle, at once after a deadline stop or a full batch. Passes never overlap. */
  start(pollMs = RELAY_POLL_MS): void {
    const tick = () => {
      this.running = this.cycle(pollMs).then((delay) => {
        if (this.timer !== null) this.timer = setTimeout(tick, delay);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Stops polling and waits for the current pass, which commits or rolls back on its own. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
    await this.db.$disconnect();
  }

  /** One loop iteration; resolves to the delay before the next one. Never rejects. */
  private async cycle(pollMs: number): Promise<number> {
    let delay = pollMs;
    try {
      const pass = await this.runOnce();
      this.consecutiveErrors = 0;
      if (pass.end === 'deadline' || pass.claimed === RELAY_BATCH) delay = 0;
      this.report(pass);
      this.options.onPass?.(pass, delay);
    } catch (err) {
      this.consecutiveErrors++;
      delay = Math.min(ERROR_BACKOFF_CAP_MS, pollMs * 2 ** this.consecutiveErrors);
      this.logger.error(
        { event: 'cache.invalidation.relay_failed', error: (err as Error).name },
        'Invalidation relay pass failed; its events stay pending',
      );
      return delay;
    }
    try {
      await this.housekeep();
    } catch (err) {
      this.logger.warn(
        { event: 'cache.invalidation.purge_failed', error: (err as Error).name },
        'Invalidation purge failed',
      );
    }
    return delay;
  }

  private pass(
    p: Partial<RelayPass> & { claimed: number; end: PassEnd; start: number },
  ): RelayPass {
    return {
      claimed: p.claimed,
      expired: p.expired ?? 0,
      published: p.published ?? 0,
      publishes: p.publishes ?? 0,
      possibleDuplicates: p.possibleDuplicates ?? 0,
      retried: p.retried ?? 0,
      end: p.end,
      durationMs: this.now() - p.start,
    };
  }

  /** Counts only (spec 0002 B9). */
  private report(pass: RelayPass): void {
    if (pass.claimed === 0) return;
    const { durationMs: _d, ...counts } = pass;
    if (pass.expired > 0)
      this.logger.warn(
        { event: 'cache.invalidation.expired', count: pass.expired },
        'Invalidation events expired unpublished; caches converged on their TTL',
      );
    if (pass.end === 'failure')
      this.logger.warn(
        { event: 'cache.invalidation.relay_backoff', ...counts },
        'Invalidation publish failed; events back off',
      );
    else
      this.logger.log(
        { event: 'cache.invalidation.relayed', ...counts },
        'Invalidation batch relayed',
      );
  }
}
