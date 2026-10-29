import { describe, expect, it } from 'vitest';
import { hasReservedFirstLabel, isReservedName, RESERVED_NAMES } from './reserved-names.js';

describe('reserved names (spec 0027 P2)', () => {
  it('covers the platform hosts that share the tenants\' domain', () => {
    for (const name of ['console', 'api', 'files', 'mail', 'www', 'admin', 'status', 'auth', 'static', 'platform']) expect(isReservedName(name)).toBe(true);
    expect(RESERVED_NAMES).toHaveLength(10);
  });

  it('ignores case and surrounding space', () => {
    expect(isReservedName('Console')).toBe(true);
    expect(isReservedName(' API ')).toBe(true);
  });

  it('lets ordinary and look-alike slugs through: only the exact names are reserved', () => {
    for (const slug of ['demo-uni', 'test-poly', 'consoles', 'console-uni', 'myapi', 'unilag']) expect(isReservedName(slug)).toBe(false);
  });

  it('reads a host\'s first label only', () => {
    expect(hasReservedFirstLabel('console.univarse.ng')).toBe(true);
    expect(hasReservedFirstLabel('console.stack.univarse.localhost')).toBe(true);
    expect(hasReservedFirstLabel('unilag.univarse.ng')).toBe(false);
    // A later label never counts: an institution's own domain may contain the word.
    expect(hasReservedFirstLabel('portal.console.example.edu.ng')).toBe(false);
  });
});
