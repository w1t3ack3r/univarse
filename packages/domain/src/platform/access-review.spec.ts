import { describe, expect, it } from 'vitest';
import { canonicalReviewedAccess, previousReviewPeriod, reviewDecisionGaps, reviewPeriod, reviewStatus } from './access-review.js';
import { isClassifiedSecurityEvent, securityLevel } from './security-levels.js';

describe('[0031 Q15] the review month', () => {
  it('is the calendar month in WAT, so the last hour of a UTC month is already the next', () => {
    expect(reviewPeriod(new Date('2026-11-30T22:59:59Z'))).toBe('2026-11');
    expect(reviewPeriod(new Date('2026-11-30T23:00:00Z'))).toBe('2026-12');
    expect(reviewPeriod(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
  });

  it('steps back across a year', () => {
    expect(previousReviewPeriod('2026-11')).toBe('2026-10');
    expect(previousReviewPeriod('2027-01')).toBe('2026-12');
  });
});

describe('[0031 Q15] the review status', () => {
  const at = new Date('2026-11-15T12:00:00Z');

  it("is done once this month's exists, and due when only last month's does", () => {
    expect(reviewStatus(at, '2026-11')).toBe('done');
    expect(reviewStatus(at, '2026-10')).toBe('due');
  });

  it('is overdue when a whole month was missed', () => {
    expect(reviewStatus(at, '2026-09')).toBe('overdue');
    expect(reviewStatus(new Date('2027-01-15T12:00:00Z'), '2026-11')).toBe('overdue');
  });

  it('a platform that has never reviewed is due, not overdue', () => {
    expect(reviewStatus(at, null)).toBe('due');
  });
});

describe("[0031 Q15] the snapshot's identity", () => {
  const a = { id: 'a', role: 'OWNER', isActive: true, mfaEnrolled: true };
  const b = { id: 'b', role: 'SUPPORT', isActive: true, mfaEnrolled: false };

  it('ignores the order members arrive in', () => {
    expect(canonicalReviewedAccess([a, b])).toBe(canonicalReviewedAccess([b, a]));
  });

  it('changes with a role, a status, an authenticator, or a member added or removed', () => {
    const base = canonicalReviewedAccess([a, b]);
    expect(canonicalReviewedAccess([{ ...a, role: 'READ_ONLY' }, b])).not.toBe(base);
    expect(canonicalReviewedAccess([a, { ...b, isActive: false }])).not.toBe(base);
    expect(canonicalReviewedAccess([a, { ...b, mfaEnrolled: true }])).not.toBe(base);
    expect(canonicalReviewedAccess([a])).not.toBe(base);
  });

  it("doesn't change with anything that moves whenever someone signs in", () => {
    const signedIn = { ...a, lastLoginAt: new Date(), activeSessions: 3 };
    expect(canonicalReviewedAccess([signedIn, b])).toBe(canonicalReviewedAccess([a, b]));
  });
});

describe("[0031 Q15] a review's decisions", () => {
  it('must cover exactly the members', () => {
    expect(reviewDecisionGaps(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], unknown: [] });
    expect(reviewDecisionGaps(['a', 'b'], ['a'])).toEqual({ missing: ['b'], unknown: [] });
    expect(reviewDecisionGaps(['a'], ['a', 'z'])).toEqual({ missing: [], unknown: ['z'] });
  });
});

describe('[0031 Q12] the security levels', () => {
  it('leads with what needs a person, and an unknown event is never the lowest level', () => {
    expect(securityLevel('files.scan.malware_detected')).toBe('act');
    expect(securityLevel('db.rls_violation')).toBe('act');
    expect(securityLevel('platform.audit.chain_broken')).toBe('act');
    expect(securityLevel('auth.account.locked')).toBe('watch');
    expect(securityLevel('auth.rate_limited')).toBe('note');
    expect(securityLevel('something.new')).toBe('watch');
    expect(isClassifiedSecurityEvent('something.new')).toBe(false);
    expect(isClassifiedSecurityEvent('constructor')).toBe(false);
  });
});
