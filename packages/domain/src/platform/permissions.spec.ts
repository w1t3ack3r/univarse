import { describe, expect, it } from 'vitest';
import {
  evaluatePlatform,
  hasFreshPlatformStepUp,
  PLATFORM_PERMISSION_CATALOG,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  STEP_UP_WINDOW_MS,
  type PlatformSubject,
} from './permissions.js';

const NOW = new Date('2026-11-02T12:00:00Z');
const full = (over: Partial<PlatformSubject> = {}): PlatformSubject => ({
  role: 'OWNER',
  isActive: true,
  mfaAt: new Date(NOW.getTime() - 60_000),
  restricted: false,
  stepUpAt: new Date(NOW.getTime() - 60_000),
  ...over,
});

describe('platform permissions (spec 0028 Q12)', () => {
  it('only OWNER manages staff, and manage needs a step-up', () => {
    for (const role of PLATFORM_ROLES) expect([role, PLATFORM_ROLE_PERMISSIONS[role].includes('platform.staff.manage')]).toEqual([role, role === 'OWNER']);
    expect(PLATFORM_PERMISSION_CATALOG['platform.staff.manage'].stepUp).toBe(true);
    expect(PLATFORM_PERMISSION_CATALOG['platform.self'].stepUp).toBe(false);
  });

  it('every role holds platform.self, and grants only catalogued permissions', () => {
    for (const role of PLATFORM_ROLES) {
      expect(PLATFORM_ROLE_PERMISSIONS[role]).toContain('platform.self');
      for (const p of PLATFORM_ROLE_PERMISSIONS[role]) expect(PLATFORM_PERMISSIONS).toContain(p);
    }
  });

  it('the whole matrix: a role allowed exactly its permissions, everything else hidden', () => {
    for (const role of PLATFORM_ROLES)
      for (const permission of PLATFORM_PERMISSIONS) {
        const d = evaluatePlatform(full({ role }), permission, NOW);
        expect([role, permission, d.allowed]).toEqual([role, permission, PLATFORM_ROLE_PERMISSIONS[role].includes(permission)]);
        if (!d.allowed) expect(d.reason).toBe('hidden');
      }
  });

  it('an inactive member, or an unknown role, is hidden whatever the permission', () => {
    expect(evaluatePlatform(full({ isActive: false }), 'platform.self', NOW)).toEqual({ allowed: false, reason: 'hidden' });
    expect(evaluatePlatform(full({ role: 'ROOT' }), 'platform.self', NOW)).toEqual({ allowed: false, reason: 'hidden' });
  });

  it('a session without TOTP reaches nothing: enrolment-only, or no second factor yet', () => {
    expect(evaluatePlatform(full({ restricted: true }), 'platform.self', NOW)).toEqual({ allowed: false, reason: 'enrolment_required' });
    expect(evaluatePlatform(full({ mfaAt: null }), 'platform.self', NOW)).toEqual({ allowed: false, reason: 'enrolment_required' });
  });

  it('hidden comes before enrolment: a member without the permission never learns more', () => {
    expect(evaluatePlatform(full({ role: 'SUPPORT', restricted: true }), 'platform.staff.manage', NOW)).toEqual({ allowed: false, reason: 'hidden' });
  });

  it('step-up: required within the window, never from the future', () => {
    expect(evaluatePlatform(full({ stepUpAt: null }), 'platform.staff.manage', NOW)).toEqual({ allowed: false, reason: 'step_up_required' });
    const at = (msAgo: number) => full({ stepUpAt: new Date(NOW.getTime() - msAgo) });
    expect(evaluatePlatform(at(STEP_UP_WINDOW_MS), 'platform.staff.manage', NOW)).toEqual({ allowed: true });
    expect(evaluatePlatform(at(STEP_UP_WINDOW_MS + 1), 'platform.staff.manage', NOW).allowed).toBe(false);
    expect(hasFreshPlatformStepUp(at(-1), NOW)).toBe(false);
    // A permission without step-up doesn't need one.
    expect(evaluatePlatform(full({ stepUpAt: null }), 'platform.staff.read', NOW)).toEqual({ allowed: true });
  });
});
