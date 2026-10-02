import { PERMISSIONS, type Permission } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { hasFreshStepUp, requiresStepUp, STEP_UP_WINDOW_MS } from './actor.js';

describe('[S1] step-up window', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const at = (msAgo: number) => ({ stepUpAt: new Date(now.getTime() - msAgo) });

  it('accepts a step-up within 5 minutes, including the boundary', () => {
    expect(hasFreshStepUp(at(0), now)).toBe(true);
    expect(hasFreshStepUp(at(STEP_UP_WINDOW_MS), now)).toBe(true);
  });

  it('rejects a step-up older than 5 minutes, or none at all', () => {
    expect(hasFreshStepUp(at(STEP_UP_WINDOW_MS + 1), now)).toBe(false);
    expect(hasFreshStepUp({ stepUpAt: null }, now)).toBe(false);
  });

  it('rejects a step-up timestamp from the future (clock tampering / bad data)', () => {
    expect(hasFreshStepUp(at(-1000), now)).toBe(false);
  });
});

describe('[S9] permission-flagged step-up', () => {
  it('flags exactly the catalog permissions marked stepUp', () => {
    const flagged = (Object.keys(PERMISSIONS) as Permission[]).filter(requiresStepUp).sort();
    expect(flagged).toEqual(['identity.role.assign', 'settings.tenant.manage']);
  });

  it('does not flag ordinary permissions', () => {
    expect(requiresStepUp('identity.user.view')).toBe(false);
    expect(requiresStepUp('org.unit.view')).toBe(false);
  });
});
