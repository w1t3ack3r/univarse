// Spec 0020 B2-11: `docker stats` memory figures, in MiB.
import { describe, expect, it } from 'vitest';
import { mib } from './memory.js';

describe('[B2-11] memory figures', () => {
  it('reads each unit docker stats prints', () => {
    expect(mib('512MiB / 1GiB')).toBe(512);
    expect(mib('1.5GiB / 3GiB')).toBe(1536);
    expect(mib('800KiB / 64MiB')).toBeCloseTo(0.78, 2);
    expect(mib('2048B / 64MiB')).toBeCloseTo(0.002, 3);
    expect(mib('-- / --')).toBe(0);
  });
});
