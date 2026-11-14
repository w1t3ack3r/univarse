import { describe, expect, it } from 'vitest';
import { clockText } from './incidents';

describe('the 72-hour clock in words (spec 0037 Q14)', () => {
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  it('counts down, then says how overdue', () => {
    expect(clockText('2026-11-16T05:12:00Z', NOW)).toEqual({ text: '41 h 12 min left', overdue: false });
    expect(clockText('2026-11-14T12:30:00Z', NOW)).toEqual({ text: '30 min left', overdue: false });
    expect(clockText('2026-11-14T09:00:00Z', NOW)).toEqual({ text: 'Overdue by 3 h 0 min', overdue: true });
  });
});
