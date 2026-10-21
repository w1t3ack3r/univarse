// Spec 0019 B1/LS7: the smoke's HSTS check accepts exactly one header with exactly the stack's value. The live check
// runs after every deploy (smoke.ts); this pins what it refuses.
import { describe, expect, it } from 'vitest';
import { HSTS, hstsProblems } from './smoke.js';

describe('[LS7] HSTS at the edge (B1)', () => {
  it('[LS7] one header with the stack value passes', () => {
    expect(HSTS).toBe('max-age=63072000; includeSubDomains');
    expect(hstsProblems(['Content-Type', 'text/html', 'Strict-Transport-Security', HSTS])).toEqual([]);
  });

  it('[LS7] a second HSTS header left in place (the API\'s own) is refused, even when one of them is right', () => {
    expect(hstsProblems(['strict-transport-security', 'max-age=63072000; includeSubDomains; preload', 'Strict-Transport-Security', HSTS])).toEqual([
      expect.stringMatching(/^2 HSTS headers/),
    ]);
  });

  it('[LS7] preload, a missing includeSubDomains, or no header at all are refused', () => {
    expect(hstsProblems(['Strict-Transport-Security', `${HSTS}; preload`])).toEqual([expect.stringMatching(/not "max-age=63072000; includeSubDomains"/)]);
    expect(hstsProblems(['Strict-Transport-Security', 'max-age=63072000'])).toEqual([expect.stringMatching(/not "/)]);
    expect(hstsProblems(['Content-Type', 'text/html'])).toEqual(['no HSTS header']);
  });
});
