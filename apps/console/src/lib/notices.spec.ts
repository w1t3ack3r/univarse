import { describe, expect, it } from 'vitest';
import { audienceText, fromLagosInput, noticeState, toLagosInput } from './notices';

describe('notices in the console (spec 0037 Q9)', () => {
  it('reads and writes maintenance windows in Nigerian time, both ways', () => {
    expect(fromLagosInput('2026-11-18T22:00')).toBe('2026-11-18T21:00:00.000Z');
    expect(toLagosInput('2026-11-18T21:00:00.000Z')).toBe('2026-11-18T22:00');
    expect(toLagosInput(fromLagosInput('2026-12-31T23:30'))).toBe('2026-12-31T23:30');
    expect(fromLagosInput('')).toBeNull();
    expect(fromLagosInput('18/11/2026 22:00')).toBeNull();
  });

  it('says who a notice is for, and where it stands', () => {
    expect(audienceText({ audience: 'RING', ring: 'PILOT', institutions: 3, status: 'PUBLISHED' })).toBe('The pilot ring (3)');
    expect(audienceText({ audience: 'TENANTS', ring: null, institutions: 1, status: 'DRAFT' })).toBe('1 chosen institution');
    expect(noticeState({ status: 'WITHDRAWN', live: false, publishedAt: null }).text).toBe('Discarded');
    expect(noticeState({ status: 'PUBLISHED', live: false, publishedAt: '2026-11-01T00:00:00Z' }).text).toBe('Ended');
  });
});
