import { describe, expect, it } from 'vitest';
import { APPROVAL_KINDS } from './approvals.js';
import {
  authorisationUsable,
  isDrillSlug,
  nextPurgeStep,
  PURGE_STEPS,
  purgeable,
  purgeAuthorisationExpiry,
  purgeReasonProblem,
  purgeStepMayRun,
  soloPurgeAllowed,
} from './purge.js';

const ALL = ['REQUESTED', 'PROVISIONING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED'];
const DAY = 86_400_000;
const none = { keysDestroyedAt: null, rowsDeletedAt: null, objectsDeletedAt: null, platformDeletedAt: null, certificateAt: null };
const at = new Date('2026-12-01T10:00:00Z');

describe('the purge (spec 0038 Q9–Q13)', () => {
  it('is for an archived institution only, never a drill tenant', () => {
    expect(ALL.filter((status) => purgeable({ status, slug: 'demo-uni' }))).toEqual(['ARCHIVED']);
    expect(purgeable({ status: 'ARCHIVED', slug: 'shred-drill-20261101' })).toBe(false);
    expect(isDrillSlug('shred-drill-x')).toBe(true);
    expect(isDrillSlug('a-shred-drill-x')).toBe(false);
  });

  it('is asked for by offboarders and approved by deciders, with no named person (Q9)', () => {
    expect(APPROVAL_KINDS['tenant.purge']).toMatchObject({ requestPermission: 'platform.tenant.offboard', approvePermission: 'platform.approval.decide', subjectField: null });
  });

  it('is authorised for 7 days from the approval, and once (Q-C1)', () => {
    expect(purgeAuthorisationExpiry(at).toISOString()).toBe('2026-12-08T10:00:00.000Z');
    expect(authorisationUsable({ executedAt: at, usedBy: null }, new Date(at.getTime() + 7 * DAY - 1))).toBe(true);
    expect(authorisationUsable({ executedAt: at, usedBy: null }, new Date(at.getTime() + 7 * DAY))).toBe(false);
    expect(authorisationUsable({ executedAt: at, usedBy: 'purge-1' }, at)).toBe(false);
  });

  it('runs solo only when nobody else could approve (Q11, A7)', () => {
    const owner = { role: 'OWNER', isActive: true, mfaEnrolled: true };
    expect(soloPurgeAllowed([owner])).toBe(true);
    expect(soloPurgeAllowed([owner, { role: 'SUPER_ADMIN', isActive: true, mfaEnrolled: true }])).toBe(false);
    expect(soloPurgeAllowed([owner, { role: 'OWNER', isActive: true, mfaEnrolled: true }])).toBe(false);
    // Nobody who couldn't approve counts: inactive, no authenticator, or a role without the decide permission.
    expect(soloPurgeAllowed([owner, { role: 'SUPER_ADMIN', isActive: false, mfaEnrolled: true }, { role: 'SUPER_ADMIN', isActive: true, mfaEnrolled: false }, { role: 'SUPPORT', isActive: true, mfaEnrolled: true }])).toBe(true);
  });

  it('takes its steps in order, keys first, and skips what is done (Q10, Q-C3, A12)', () => {
    expect(PURGE_STEPS).toEqual(['keys', 'rows', 'objects', 'platform', 'certificate']);
    expect(nextPurgeStep(none)).toBe('keys');
    expect(purgeStepMayRun(none, 'rows')).toBe(false);
    const keys = { ...none, keysDestroyedAt: at };
    expect(nextPurgeStep(keys)).toBe('rows');
    expect(purgeStepMayRun(keys, 'keys')).toBe(false);
    // A later step recorded out of order never lets an earlier one be skipped.
    expect(nextPurgeStep({ ...none, rowsDeletedAt: at, objectsDeletedAt: at })).toBe('keys');
    expect(nextPurgeStep({ keysDestroyedAt: at, rowsDeletedAt: at, objectsDeletedAt: at, platformDeletedAt: at, certificateAt: null })).toBe('certificate');
    expect(nextPurgeStep({ keysDestroyedAt: at, rowsDeletedAt: at, objectsDeletedAt: at, platformDeletedAt: at, certificateAt: at })).toBeNull();
  });

  it('needs a real reason to run solo', () => {
    expect(purgeReasonProblem(undefined)).toBe(true);
    expect(purgeReasonProblem('   short  ')).toBe(true);
    expect(purgeReasonProblem('The only owner, before a second member joins')).toBe(false);
    expect(purgeReasonProblem('x'.repeat(501))).toBe(true);
  });
});
