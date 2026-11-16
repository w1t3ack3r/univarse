import { describe, expect, it } from 'vitest';
import { archiveDue, cancellable, daysLeft, dueWarning, extendable, offboardable, offboardingNoteProblem, testClockArchiveProblem, windowEnd } from './offboarding.js';
import { PLATFORM_PERMISSION_CATALOG, PLATFORM_ROLE_PERMISSIONS } from './permissions.js';
import { resumableTo, suspendable } from './suspension.js';
import type { TenantStatusName } from './tenant-registry.js';

const ALL: TenantStatusName[] = ['REQUESTED', 'PROVISIONING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED'];
const DAY = 86_400_000;

describe('offboarding (spec 0038 Q2–Q6)', () => {
  it('starts from active or onboarding only', () => {
    expect(ALL.filter(offboardable)).toEqual(['ONBOARDING', 'ACTIVE']);
  });

  it('ends at the end of its last day in Nigerian time', () => {
    // 14 Nov 2026, 22:30 WAT (21:30 UTC): day 0 is the 14th; 60 days later is 13 Jan 2027, ending 23:59:59.999 WAT.
    expect(windowEnd(new Date('2026-11-14T21:30:00Z'), 60).toISOString()).toBe('2027-01-13T22:59:59.999Z');
    // 15 Nov 2026, 00:30 WAT (14 Nov 23:30 UTC) is already the 15th in Lagos.
    expect(windowEnd(new Date('2026-11-14T23:30:00Z'), 60).toISOString()).toBe('2027-01-14T22:59:59.999Z');
  });

  it('counts days left as people do: 1 on the last day, 0 after', () => {
    const end = new Date('2027-01-13T22:59:59.999Z');
    expect(daysLeft(end, new Date('2027-01-13T08:00:00Z'))).toBe(1);
    expect(daysLeft(end, new Date('2027-01-12T08:00:00Z'))).toBe(2);
    expect(daysLeft(end, new Date('2027-01-14T00:00:00Z'))).toBe(0);
  });

  it('sends each warning once, and after a gap only the latest due, never a backlog (Q4)', () => {
    const end = new Date('2027-01-13T22:59:59.999Z');
    const at = (left: number) => new Date(end.getTime() - left * DAY + 1);
    expect(dueWarning(0, end, [], at(60))).toBe(60);
    // The day it starts: the rest of today and 60 more, so 61 days left; the announcement is due.
    expect(dueWarning(0, end, [], at(61))).toBe(60);
    expect(dueWarning(0, end, [60], at(50))).toBeNull();
    expect(dueWarning(0, end, [60], at(45))).toBe(45);
    expect(dueWarning(0, end, [60, 45], at(13))).toBe(14);
    expect(dueWarning(0, end, [60, 45, 14], at(13))).toBeNull();
    expect(dueWarning(0, end, [60, 45, 14, 7], at(1))).toBe(1);
    expect(dueWarning(0, end, [60, 45, 30, 14, 7, 1], at(1))).toBeNull();
    expect(dueWarning(0, end, [], new Date(end.getTime() + 1))).toBeNull();
    // The extension's own round.
    expect(dueWarning(1, end, [], at(14))).toBe(14);
    expect(dueWarning(1, end, [14], at(7))).toBe(7);
  });

  it('archives after the last day, cancels only before it, and extends an archive once', () => {
    const end = new Date('2027-01-13T22:59:59.999Z');
    expect(archiveDue('OFFBOARDING', end, new Date(end.getTime() + 1))).toBe(true);
    expect(archiveDue('OFFBOARDING', end, end)).toBe(false);
    expect(archiveDue('SUSPENDED', end, new Date(end.getTime() + 1))).toBe(false);
    expect(cancellable('OFFBOARDING', end, end)).toBe(true);
    expect(cancellable('OFFBOARDING', end, new Date(end.getTime() + 1))).toBe(false);
    expect(cancellable('ARCHIVED', end, end)).toBe(false);
    expect(extendable('ARCHIVED', 0)).toBe(true);
    expect(extendable('ARCHIVED', 1)).toBe(false);
    expect(extendable('OFFBOARDING', 0)).toBe(false);
  });

  it('can be suspended during the window, and a resume returns to offboarding (Q3)', () => {
    expect(suspendable('OFFBOARDING')).toBe(true);
    expect(resumableTo('OFFBOARDING')).toBe(true);
  });

  it('needs a note for "other"', () => {
    expect(offboardingNoteProblem('OTHER', ' ')).toBe('note_required');
    expect(offboardingNoteProblem('CONTRACT_ENDED', null)).toBeNull();
    expect(offboardingNoteProblem('OTHER', 'x'.repeat(201))).toBe('note_length');
  });

  it('is OWNER and SUPER_ADMIN, with a step-up (Q1)', () => {
    expect(PLATFORM_PERMISSION_CATALOG['platform.tenant.offboard'].stepUp).toBe(true);
    expect(Object.entries(PLATFORM_ROLE_PERMISSIONS).filter(([, ps]) => ps.includes('platform.tenant.offboard')).map(([r]) => r)).toEqual(['OWNER', 'SUPER_ADMIN']);
  });
});

describe("the stack's test clock (spec 0038 Q-D3)", () => {
  it('archives only an institution leaving that never went live', () => {
    const allowed = ALL.flatMap((status) => ALL.map((previousStatus) => ({ status, previousStatus }))).filter((i) => testClockArchiveProblem(i) === null);
    expect(allowed).toEqual([{ status: 'OFFBOARDING', previousStatus: 'ONBOARDING' }]);
  });

  it('refuses one that went live, whatever its status now', () => {
    for (const status of ALL) expect(testClockArchiveProblem({ status, previousStatus: 'ACTIVE' })).toBe('went_live');
  });

  it('refuses one with no open offboarding, and one suspended during it', () => {
    expect(testClockArchiveProblem({ status: 'ONBOARDING', previousStatus: null })).toBe('not_offboarding');
    expect(testClockArchiveProblem({ status: 'OFFBOARDING', previousStatus: null })).toBe('not_offboarding');
    expect(testClockArchiveProblem({ status: 'SUSPENDED', previousStatus: 'ONBOARDING' })).toBe('not_offboarding');
  });

  it('reports an archived one as already archived', () => {
    expect(testClockArchiveProblem({ status: 'ARCHIVED', previousStatus: 'ONBOARDING' })).toBe('already_archived');
  });
});
