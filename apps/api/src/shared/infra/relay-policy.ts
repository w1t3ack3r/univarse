// Spec 0016: the platform invalidation relay's pure rules (coalescing, timing, backoff), unit-tested.
import { randomInt } from 'node:crypto';
import { PUBLISH_TIMEOUT_MS } from './invalidation-bus.js';

/** IO11: a pass stops publishing this long after its claim. */
export const BATCH_DEADLINE_MS = 2_000;
/** IO11: the client's limit on the relay's transaction (the role's transaction_timeout, 5 s, is behind it). */
export const RELAY_TX_TIMEOUT_MS = 3_000;
export const RELAY_BATCH = 200;
/** D4: the idle poll. */
export const RELAY_POLL_MS = 250;
/** IO18: housekeeping at most once a minute, in batches of 1 000. */
export const PURGE_INTERVAL_MS = 60_000;
export const PURGE_BATCH = 1_000;

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const JITTER = 0.2;

export interface ClaimedEvent {
  readonly id: string;
  readonly channel: string;
  readonly tenantId: string;
  readonly attempts: number;
}

export interface Publication {
  readonly channel: string;
  readonly tenantId: string;
  /** Every claimed event this one publish settles. */
  readonly eventIds: string[];
}

/**
 * IO18: one publish per distinct (channel, tenant) in a claimed batch, in order of first appearance (the claim is
 * oldest first). The same tenant on both channels is two publishes; nothing groups across batches.
 */
export function coalesce(events: readonly ClaimedEvent[]): Publication[] {
  const byKey = new Map<string, Publication>();
  for (const e of events) {
    const key = `${e.channel}\u0000${e.tenantId}`;
    const found = byKey.get(key);
    if (found) found.eventIds.push(e.id);
    else byKey.set(key, { channel: e.channel, tenantId: e.tenantId, eventIds: [e.id] });
  }
  return [...byKey.values()];
}

/** IO11: a publish's budget, `min(5 s, time left before the deadline)`; zero or less means the deadline passed. */
export function publishBudgetMs(deadline: number, now: number): number {
  return Math.min(PUBLISH_TIMEOUT_MS, deadline - now);
}

/**
 * IO11: what an unsuccessful publish means. A timeout on a budget the deadline clipped is deadline exhaustion
 * (the events stay as they are); a timeout on the full budget, or any other failure (Valkey unavailable), is a
 * failure (the events back off).
 */
export function classifyFailure(reason: string, budgetMs: number): 'deadline' | 'failure' {
  return reason === 'publish timed out' && budgetMs < PUBLISH_TIMEOUT_MS ? 'deadline' : 'failure';
}

/** The error class stored in last_error: a fixed label, never the client's message (spec 0002 B9). */
export function failureLabel(reason: string): string {
  return reason === 'publish timed out' ? 'PublishTimeout' : 'PublishFailed';
}

const unitRandom = () => randomInt(0, 1_000_001) / 1_000_000;

/** IO11: the delay after a failed attempt `attempt` (1-based): 250 ms × 2^(n−1), ±20 %, never above 5 s. */
export function relayBackoffMs(attempt: number, random: () => number = unitRandom): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.min(BACKOFF_CAP_MS, Math.round(base * (1 - JITTER + 2 * JITTER * random())));
}
