// Spec 0020 D15: the pure rule deciding whether a retired key version may be destroyed.
import { TENANT_TX_TIMEOUT_MS } from '@univarse/db';
import { describe, expect, it } from 'vitest';
import { GRACE_MARGIN_MS, graceProblem, retiredKeyProblem, type RetiredKeyState } from './keys.js';

const G = 60 * 60_000;
const retiredAt = new Date('2026-10-22T10:00:00.000Z');
const eligibleFrom = retiredAt.getTime() + G;
const sweep = (startedAt: number, completedAt: number | null = startedAt + 1_000, unreadableRemaining = 0n) => ({
  startedAt: new Date(startedAt),
  completedAt: completedAt === null ? null : new Date(completedAt),
  unreadableRemaining,
});
const state = (over: Partial<RetiredKeyState> = {}): RetiredKeyState => ({
  status: 'RETIRED',
  retiredAt,
  sweep: sweep(eligibleFrom + 5_000),
  ...over,
});
const now = eligibleFrom + 60_000;

describe('[D15] retiredKeyProblem', () => {
  it('[D15] eligible only when retired past G with a completed, clean sweep that started at or after retired_at + G', () => {
    expect(retiredKeyProblem(state(), now, G)).toBeNull();
    expect(retiredKeyProblem(state({ sweep: sweep(eligibleFrom) }), now, G)).toBeNull(); // the boundary qualifies
  });

  it.each<[string, RetiredKeyState, number]>([
    ['not_retired', state({ status: 'ACTIVE' }), now],
    ['not_retired', state({ status: 'DESTROYED' }), now],
    ['not_retired', state({ status: null }), now],
    ['not_retired', state({ retiredAt: null }), now],
    ['grace_period', state(), eligibleFrom - 1],
    ['sweep_pending', state({ sweep: null }), now],
    ['sweep_pending', state({ sweep: sweep(eligibleFrom - 1) }), now], // started before retired_at + G
    ['sweep_pending', state({ sweep: sweep(eligibleFrom + 5_000, null) }), now], // not completed
    ['sweep_pending', state({ sweep: sweep(eligibleFrom + 5_000, eligibleFrom + 4_000) }), now], // completion predates this start
    ['sweep_pending', state({ sweep: sweep(eligibleFrom + 5_000, undefined, 1n) }), now], // unreadable values left
    ['sweep_pending', state({ sweep: { startedAt: null, completedAt: new Date(now), unreadableRemaining: 0n } }), now],
  ])('[D15] %s', (why, s, at) => {
    expect(retiredKeyProblem(s, at, G)).toBe(why);
  });

  it('[D15] the grace period is measured from retired_at with the G given', () => {
    const shortG = TENANT_TX_TIMEOUT_MS + GRACE_MARGIN_MS;
    const s = state({ sweep: sweep(retiredAt.getTime() + shortG) });
    expect(retiredKeyProblem(s, retiredAt.getTime() + shortG + 1_000, shortG)).toBeNull();
    expect(retiredKeyProblem(s, retiredAt.getTime() + shortG + 1_000, G)).toBe('grace_period');
  });
});

describe('[D15] graceProblem', () => {
  it('[D15] G is never below W plus 60 s', () => {
    expect(graceProblem(TENANT_TX_TIMEOUT_MS + GRACE_MARGIN_MS)).toBeNull();
    expect(graceProblem(TENANT_TX_TIMEOUT_MS + GRACE_MARGIN_MS - 1)).toMatch(/writer bound/);
    expect(GRACE_MARGIN_MS).toBe(60_000);
    expect(TENANT_TX_TIMEOUT_MS).toBe(10_000);
  });
});
