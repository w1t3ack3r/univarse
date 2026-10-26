// Spec 0020 B2-7: the WAL a target needs, a gap stopping at once, and a missing tail waited for.
import { describe, expect, it } from 'vitest';
import { walFileName } from '../backup/pgbase.js';
import { nextSegment, segmentsBetween, walNeed } from './wal-range.js';

const seg = (n: number, tl = 1) => walFileName(`${(Math.floor(n / 256)).toString(16)}/${((n % 256) * 0x1000000).toString(16)}`, tl);

describe('[B2-7] the segments between two points', () => {
  it('counts on within an xlogid and carries into the next one after segment FF', () => {
    expect(nextSegment('000000010000000000000004')).toBe('000000010000000000000005');
    expect(nextSegment('0000000100000000000000FF')).toBe('000000010000000100000000');
    expect(segmentsBetween('0000000100000000000000FE', '000000010000000100000001')).toEqual([
      '0000000100000000000000FE',
      '0000000100000000000000FF',
      '000000010000000100000000',
      '000000010000000100000001',
    ]);
  });

  it('agrees with the base backup’s own naming (pgbase.ts) across the xlogid boundary', () => {
    expect(segmentsBetween(seg(250), seg(260))).toEqual(Array.from({ length: 11 }, (_, i) => seg(250 + i)));
  });

  it('refuses a target before the start, and two timelines', () => {
    expect(() => segmentsBetween(seg(5), seg(4))).toThrow(/before the set's start/);
    expect(() => segmentsBetween(seg(5, 1), seg(6, 2))).toThrow(/different timelines/);
  });
});

describe('[B2-7] what a target needs', () => {
  const start = seg(10);

  it('complete: every segment from the start through the target, older and later ones left out', () => {
    const shipped = [seg(8), seg(9), seg(10), seg(11), seg(12), seg(13)];
    expect(walNeed(start, 1, seg(12), shipped)).toEqual({ state: 'complete', files: [seg(10), seg(11), seg(12)] });
  });

  it('waiting: only the newest are missing, so they may still arrive', () => {
    expect(walNeed(start, 1, seg(13), [seg(10), seg(11)])).toEqual({ state: 'waiting', missing: [seg(12), seg(13)], newestShipped: seg(11) });
    expect(walNeed(start, 1, seg(10), [])).toEqual({ state: 'waiting', missing: [seg(10)], newestShipped: null });
  });

  it('gap: a missing segment with a later one shipped stops at once, naming it', () => {
    expect(walNeed(start, 1, seg(13), [seg(10), seg(12), seg(13)])).toEqual({ state: 'gap', missing: seg(11) });
    // The target's own segment missing while a later one is shipped is a gap too: PostgreSQL archives in order.
    expect(walNeed(start, 1, seg(12), [seg(10), seg(11), seg(13)])).toEqual({ state: 'gap', missing: seg(12) });
  });

  it('a time target needs everything from the start through the newest shipped, without a gap', () => {
    expect(walNeed(start, 1, 'newest', [seg(10), seg(11), seg(12)])).toEqual({ state: 'complete', files: [seg(10), seg(11), seg(12)] });
    expect(walNeed(start, 1, 'newest', [seg(10), seg(12)])).toEqual({ state: 'gap', missing: seg(11) });
  });

  it('a later timeline needs its history file first, and refuses without it', () => {
    const s2 = seg(10, 2);
    expect(walNeed(s2, 2, seg(11, 2), ['00000002.history', s2, seg(11, 2)])).toEqual({ state: 'complete', files: ['00000002.history', s2, seg(11, 2)] });
    expect(walNeed(s2, 2, seg(11, 2), [s2, seg(11, 2)])).toEqual({ state: 'no-history', missing: '00000002.history' });
    // Another timeline's segments never fill this one's.
    expect(walNeed(s2, 2, seg(11, 2), ['00000002.history', s2, seg(11, 1)]).state).toBe('waiting');
  });

  it('refuses a start that is not on the set’s timeline', () => {
    expect(() => walNeed(seg(10, 1), 2, seg(11, 2), [])).toThrow(/not on its timeline/);
  });
});
