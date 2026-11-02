// Spec 0028 Q13: the platform always keeps an active OWNER. Pure, so the boundary is tested exactly; the integration
// tests can't, because the shared test database holds other OWNERs.
import { describe, expect, it } from 'vitest';
import { leavesNoOwner } from './staff.service.js';

const owner = { role: 'OWNER', isActive: true };

describe('leavesNoOwner (spec 0028 Q13)', () => {
  it('refuses demoting or deactivating the only active OWNER', () => {
    expect(leavesNoOwner(owner, { role: 'SUPER_ADMIN' }, 1)).toBe(true);
    expect(leavesNoOwner(owner, { deactivate: true }, 1)).toBe(true);
  });

  it('allows it while another active OWNER remains', () => {
    expect(leavesNoOwner(owner, { role: 'SUPER_ADMIN' }, 2)).toBe(false);
    expect(leavesNoOwner(owner, { deactivate: true }, 2)).toBe(false);
  });

  it('a change that keeps the OWNER role, or a target that is not an active OWNER, never trips it', () => {
    expect(leavesNoOwner(owner, { role: 'OWNER' }, 1)).toBe(false);
    expect(leavesNoOwner({ role: 'OWNER', isActive: false }, { deactivate: true }, 0)).toBe(false);
    expect(leavesNoOwner({ role: 'SUPPORT', isActive: true }, { deactivate: true }, 1)).toBe(false);
  });
});
