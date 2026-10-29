// Spec 0027 acceptance 2: no seeded tenant holds a reserved name (the console's own, say).
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../packages/db-ops/src/seed-tenants.js';
import { isReservedName } from '../../../packages/domain/src/platform/reserved-names.js';

describe('the seeded tenants', () => {
  it('hold no reserved name', () => {
    expect(TENANTS.length).toBeGreaterThan(0);
    for (const t of TENANTS) expect(isReservedName(t.slug)).toBe(false);
  });
});
