// Retry policy for outbox delivery (spec 0002 B4). Pure, so it is unit-tested.
import { randomInt } from 'node:crypto';

export const MAX_ATTEMPTS = 8;
const BASE_MS = 30_000;
const CAP_MS = 60 * 60_000;
const JITTER = 0.2;

/** Delay before the next attempt after `attempt` failures (1-based): 30 s × 2^(n−1), capped at 1 h, ±20 %. */
const unitRandom = () => randomInt(0, 1_000_001) / 1_000_000;

export function backoffMs(attempt: number, random: () => number = unitRandom): number {
  const base = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

/**
 * What may be stored in `last_error`: the error class and SMTP codes, never the message,
 * which can contain recipient addresses (invariant 8).
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return 'UnknownError';
  const e = err as Error & { code?: unknown; responseCode?: unknown };
  // Allow-list, not strip: a field that doesn't look like a code is dropped entirely.
  const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(e.code) ? e.code : '';
  const response = typeof e.responseCode === 'number' && Number.isInteger(e.responseCode) && e.responseCode >= 100 && e.responseCode < 1000 ? String(e.responseCode) : '';
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error';
  return [name, code, response].filter(Boolean).join(':');
}
