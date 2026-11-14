import { describe, expect, it } from 'vitest';
import { PLATFORM_ROLE_PERMISSIONS, PLATFORM_PERMISSION_CATALOG } from './permissions.js';
import { isSuspensionReason, resumableTo, resumeRefusal, suspendable, SUSPENSION_REASONS, suspensionNoteProblem } from './suspension.js';
import type { TenantStatusName } from './tenant-registry.js';

const ALL: TenantStatusName[] = ['REQUESTED', 'PROVISIONING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED'];

describe('suspension (spec 0037 Q6, Q7)', () => {
  it('starts only from ACTIVE or ONBOARDING, and resumes only to those', () => {
    expect(ALL.filter(suspendable)).toEqual(['ONBOARDING', 'ACTIVE']);
    expect(ALL.filter(resumableTo)).toEqual(['ONBOARDING', 'ACTIVE']);
  });

  it('has a fixed list of reasons, and non-payment is not one', () => {
    expect(SUSPENSION_REASONS).toEqual(['SECURITY_INCIDENT', 'REGULATOR_ORDER', 'CONTRACT_ENDED', 'INSTITUTION_ASKED', 'OTHER']);
    expect(isSuspensionReason('NON_PAYMENT')).toBe(false);
    expect(isSuspensionReason('UNPAID')).toBe(false);
    expect(isSuspensionReason('OTHER')).toBe(true);
  });

  it('needs a note for "other", 3 to 200 characters, and whitespace is no note', () => {
    expect(suspensionNoteProblem('OTHER', null)).toBe('note_required');
    expect(suspensionNoteProblem('OTHER', '   ')).toBe('note_required');
    expect(suspensionNoteProblem('OTHER', 'ab')).toBe('note_length');
    expect(suspensionNoteProblem('OTHER', 'abc')).toBeNull();
    expect(suspensionNoteProblem('OTHER', 'x'.repeat(200))).toBeNull();
    expect(suspensionNoteProblem('OTHER', 'x'.repeat(201))).toBe('note_length');
    expect(suspensionNoteProblem('SECURITY_INCIDENT', null)).toBeNull();
    expect(suspensionNoteProblem('SECURITY_INCIDENT', 'x'.repeat(201))).toBe('note_length');
  });

  it('refuses a resume until the worker has ended every session', () => {
    expect(resumeRefusal({ status: 'ACTIVE' }, null)).toBe('not_suspended');
    expect(resumeRefusal({ status: 'SUSPENDED' }, { sessionsEndedAt: null })).toBe('sessions_ending');
    expect(resumeRefusal({ status: 'SUSPENDED' }, { sessionsEndedAt: new Date() })).toBeNull();
    // The seed's suspended institution has no suspension row: nothing to wait for.
    expect(resumeRefusal({ status: 'SUSPENDED' }, null)).toBeNull();
  });

  it('is OWNER and SUPER_ADMIN only, with a step-up (Q1)', () => {
    expect(PLATFORM_PERMISSION_CATALOG['platform.tenant.suspend'].stepUp).toBe(true);
    const holders = Object.entries(PLATFORM_ROLE_PERMISSIONS)
      .filter(([, ps]) => ps.includes('platform.tenant.suspend'))
      .map(([r]) => r);
    expect(holders).toEqual(['OWNER', 'SUPER_ADMIN']);
  });
});
