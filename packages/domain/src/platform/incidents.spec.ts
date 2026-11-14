import { describe, expect, it } from 'vitest';
import { BREACH_CLOCK_MS, breachDeadline, incidentShows, INCIDENT_PUBLIC_MAX, openingProblems, RESOLVED_SHOWN_MS, updatable, updateProblems } from './incidents.js';
import { PLATFORM_PERMISSION_CATALOG, PLATFORM_ROLE_PERMISSIONS } from './permissions.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const H = 3_600_000;
const opening = (over: Partial<Parameters<typeof openingProblems>[0]> = {}) => ({
  title: 'Results pages slow to load',
  publicText: 'We are looking into slow results pages.',
  internalNote: null,
  scope: 'ALL' as const,
  tenantIds: [] as string[],
  startedAt: new Date(NOW.getTime() - H),
  awareAt: new Date(NOW.getTime() - H / 2),
  ...over,
});
const problems = (over: Partial<Parameters<typeof openingProblems>[0]>) => openingProblems(opening(over), NOW).map(([, p]) => p);

describe('incidents (spec 0037 Q13, Q14)', () => {
  it('opens with a one-line title, public text, an audience, and times that make sense', () => {
    expect(problems({})).toEqual([]);
    expect(problems({ title: 'ab' })).toEqual(['title_length']);
    expect(problems({ title: 'Down\nBcc: x' })).toEqual(['control_characters']);
    expect(problems({ publicText: 'x'.repeat(INCIDENT_PUBLIC_MAX + 1) })).toEqual(['text_length']);
    expect(problems({ scope: 'TENANTS' })).toEqual(['tenants_required']);
    expect(problems({ startedAt: new Date(NOW.getTime() + H), awareAt: new Date(NOW.getTime() + 2 * H) })).toEqual(['in_the_future', 'in_the_future']);
    expect(problems({ awareAt: new Date(NOW.getTime() - 2 * H) })).toEqual(['aware_before_start']);
  });

  it('keeps markup as text, but refuses control characters and bidirectional overrides', () => {
    expect(updateProblems({ publicText: '<script>alert(1)</script> fixed', internalNote: '<b>root cause</b>' })).toEqual([]);
    expect(updateProblems({ publicText: 'ok ‮txt.exe', internalNote: null }).map(([, p]) => p)).toEqual(['control_characters']);
  });

  it('is final once resolved: a recurrence is a new incident', () => {
    expect(['INVESTIGATING', 'IDENTIFIED', 'MONITORING'].every((s) => updatable(s as 'INVESTIGATING'))).toBe(true);
    expect(updatable('RESOLVED')).toBe(false);
  });

  it('shows while open, and for a day after it is resolved (Q14)', () => {
    expect(incidentShows({ status: 'MONITORING', resolvedAt: null }, NOW)).toBe(true);
    expect(incidentShows({ status: 'RESOLVED', resolvedAt: new Date(NOW.getTime() - RESOLVED_SHOWN_MS + 1) }, NOW)).toBe(true);
    expect(incidentShows({ status: 'RESOLVED', resolvedAt: new Date(NOW.getTime() - RESOLVED_SHOWN_MS) }, NOW)).toBe(false);
  });

  it('runs the 72-hour clock from awareness when personal data may be involved, yes or not yet known', () => {
    const awareAt = new Date(NOW.getTime() - H);
    expect(breachDeadline({ personalData: 'YES', awareAt })?.getTime()).toBe(awareAt.getTime() + BREACH_CLOCK_MS);
    expect(breachDeadline({ personalData: 'UNKNOWN', awareAt })?.getTime()).toBe(awareAt.getTime() + BREACH_CLOCK_MS);
    expect(breachDeadline({ personalData: 'NO', awareAt })).toBeNull();
  });

  it('is run by OWNER, SUPER_ADMIN and SUPPORT, with a step-up (Q1)', () => {
    const holders = Object.entries(PLATFORM_ROLE_PERMISSIONS)
      .filter(([, ps]) => ps.includes('platform.incident.manage'))
      .map(([r]) => r);
    expect(holders).toEqual(['OWNER', 'SUPER_ADMIN', 'SUPPORT']);
    expect(PLATFORM_PERMISSION_CATALOG['platform.incident.manage'].stepUp).toBe(true);
  });
});
