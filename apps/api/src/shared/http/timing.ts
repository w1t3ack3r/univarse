import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Runs `fn` and resolves no earlier than `minMs` after it started — whether it succeeds or throws.
 * Used on enumeration-sensitive endpoints so "account exists" paths (extra DB writes) and
 * "no such account" paths take the same wall-clock time (spec 0001 R15).
 * `minMs` must exceed the slowest legitimate non-success path, or the floor stops hiding anything.
 */
export async function withMinimumDuration<T>(minMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const remaining = minMs - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}
