import { describe, expect, it } from 'vitest';
import { auditQuery, fillSeries, securityHeadline } from './observe';

const none = { actionGroup: '', actorId: '', from: '', to: '' };
const NOW = Date.parse('2026-11-07T10:30:00Z');

describe('auditQuery', () => {
  it('asks for nothing when nothing is chosen', () => {
    expect(auditQuery(none)).toBe('');
  });

  it('reads a picked day as the whole of that day in WAT', () => {
    const q = new URLSearchParams(auditQuery({ ...none, from: '2026-11-07', to: '2026-11-07' }));
    expect(q.get('from')).toBe('2026-11-06T23:00:00.000Z');
    expect(q.get('to')).toBe('2026-11-07T22:59:59.999Z');
  });

  it('carries the filters and the cursor together: the next page stays filtered', () => {
    const q = new URLSearchParams(auditQuery({ ...none, actionGroup: 'platform.auth' }, 'abc'));
    expect(q.get('actionGroup')).toBe('platform.auth');
    expect(q.get('cursor')).toBe('abc');
  });
});

describe('securityHeadline', () => {
  it('leads with what needs a person, in the right number', () => {
    expect(securityHeadline({ totals: { act: 1, watch: 9, note: 9 } })).toBe('1 event needs someone to look at it.');
    expect(securityHeadline({ totals: { act: 2, watch: 0, note: 0 } })).toBe('2 events need someone to look at them.');
  });

  it('says plainly when nothing does', () => {
    expect(securityHeadline({ totals: { act: 0, watch: 1, note: 0 } })).toBe('Nothing needs you urgently. 1 event is worth watching.');
    expect(securityHeadline({ totals: { act: 0, watch: 0, note: 3 } })).toBe('Nothing needs you. A few routine events were recorded.');
    expect(securityHeadline({ totals: { act: 0, watch: 0, note: 0 } })).toBe('Nothing to report.');
  });
});

describe('fillSeries', () => {
  it('holds a bucket for every hour, with the quiet ones at zero', () => {
    const points = fillSeries({ window: '24h', series: [{ at: '2026-11-07T08:00:00.000Z', act: 1, watch: 2, note: 3 }] }, NOW);
    expect(points).toHaveLength(25);
    expect(points.at(-1)?.at).toBe('2026-11-07T10:00:00.000Z');
    expect(points.at(-3)).toMatchObject({ act: 1, watch: 2, note: 3 });
    expect(points.at(-2)).toMatchObject({ act: 0, watch: 0, note: 0 });
  });

  it('keeps the oldest part-bucket the totals counted', () => {
    const oldest = { at: '2026-11-06T10:00:00.000Z', act: 0, watch: 0, note: 7 };
    expect(fillSeries({ window: '24h', series: [oldest] }, NOW)[0]).toEqual(oldest);
    const day = { at: '2026-10-31T00:00:00.000Z', act: 0, watch: 4, note: 0 };
    expect(fillSeries({ window: '7d', series: [day] }, NOW)[0]).toEqual(day);
    expect(fillSeries({ window: '30d', series: [] }, NOW)).toHaveLength(31);
  });
});
