import { describe, expect, it } from 'vitest';
import {
  audienceOf,
  bannerAudience,
  bannerFor,
  bannerShows,
  MAINTENANCE_MAX_MS,
  NOTICE_BODY_MAX,
  NOTICE_SHOWN_FOR_MS,
  NOTICE_TENANTS_MAX,
  NOTICE_TITLE_MAX,
  noticeProblems,
  shownUntil,
  type NoticeDraft,
} from './notices.js';
import { PLATFORM_PERMISSION_CATALOG, PLATFORM_ROLE_PERMISSIONS } from './permissions.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const H = 3_600_000;
const draft = (over: Partial<NoticeDraft> = {}): NoticeDraft => ({
  kind: 'ANNOUNCEMENT',
  title: 'New results screens',
  body: 'From Monday, results open in the new screens.',
  audience: 'ALL',
  ring: null,
  tenantIds: [],
  startsAt: null,
  endsAt: null,
  ...over,
});
const problems = (over: Partial<NoticeDraft>) => noticeProblems(draft(over), NOW).map(([, p]) => p);

describe('notices (spec 0037 Q9, Q10, Q12)', () => {
  it('accepts a plain announcement, and keeps markup as text (T34: nothing is refused for looking like HTML)', () => {
    expect(problems({})).toEqual([]);
    expect(problems({ body: '<script>alert(1)</script><img src=x onerror=alert(1)>' })).toEqual([]);
  });

  it('holds the title and body to their lengths, trimmed', () => {
    expect(problems({ title: 'ab' })).toEqual(['title_length']);
    expect(problems({ title: '   ab   ' })).toEqual(['title_length']);
    expect(problems({ title: 'x'.repeat(NOTICE_TITLE_MAX) })).toEqual([]);
    expect(problems({ title: 'x'.repeat(NOTICE_TITLE_MAX + 1) })).toEqual(['title_length']);
    expect(problems({ body: 'x'.repeat(NOTICE_BODY_MAX + 1) })).toEqual(['body_length']);
  });

  it('refuses control characters and bidirectional overrides, but keeps newlines and tabs', () => {
    expect(problems({ body: 'line one\nline two\tend' })).toEqual([]);
    expect(problems({ title: 'Pay here ‮gnp.exe' })).toEqual(['control_characters']);
    expect(problems({ body: 'bell \u0007 here' })).toEqual(['control_characters']);
    // A title becomes an email subject: one line only.
    expect(problems({ title: 'Hello\r\nBcc: everyone@example.test' })).toEqual(['control_characters']);
  });

  it('needs its audience: a ring for a ring, institutions for chosen institutions, and no more than the cap', () => {
    expect(problems({ audience: 'RING' })).toEqual(['ring_required']);
    expect(problems({ audience: 'RING', ring: 'PILOT' })).toEqual([]);
    expect(problems({ audience: 'TENANTS' })).toEqual(['tenants_required']);
    expect(problems({ audience: 'TENANTS', tenantIds: Array.from({ length: NOTICE_TENANTS_MAX + 1 }, (_, i) => String(i)) })).toEqual(['too_many_tenants']);
  });

  it('gives maintenance a window that ends after it starts, in the future, within a week; nothing else has one', () => {
    const m = (startsAt: Date | null, endsAt: Date | null) => problems({ kind: 'MAINTENANCE', startsAt, endsAt });
    expect(m(null, null)).toEqual(['window_required']);
    expect(m(new Date(NOW.getTime() + H), new Date(NOW.getTime() + 3 * H))).toEqual([]);
    expect(m(new Date(NOW.getTime() + 3 * H), new Date(NOW.getTime() + H))).toEqual(['window_order']);
    expect(m(new Date(NOW.getTime() - 3 * H), new Date(NOW.getTime() - H))).toEqual(['window_past']);
    expect(m(new Date(NOW.getTime()), new Date(NOW.getTime() + MAINTENANCE_MAX_MS + 1))).toEqual(['window_too_long']);
    expect(problems({ startsAt: new Date(NOW.getTime() + H), endsAt: new Date(NOW.getTime() + 2 * H) })).toEqual(['window_not_maintenance']);
  });

  it('shows maintenance until its window ends, the rest for 14 days, and nothing withdrawn', () => {
    const end = new Date(NOW.getTime() + 5 * H);
    expect(shownUntil('MAINTENANCE', NOW, end)).toEqual(end);
    expect(shownUntil('RELEASE_NOTE', NOW, null).getTime()).toBe(NOW.getTime() + NOTICE_SHOWN_FOR_MS);
    expect(bannerShows({ kind: 'ANNOUNCEMENT', shownUntil: end, withdrawn: false }, NOW)).toBe(true);
    expect(bannerShows({ kind: 'ANNOUNCEMENT', shownUntil: end, withdrawn: true }, NOW)).toBe(false);
    expect(bannerShows({ kind: 'ANNOUNCEMENT', shownUntil: NOW, withdrawn: false }, NOW)).toBe(false);
  });

  it('shows maintenance to everyone, announcements and release notes to IT Admins only (Q10)', () => {
    expect(bannerAudience('MAINTENANCE')).toBe('everyone');
    expect(bannerFor('MAINTENANCE', false)).toBe(true);
    expect(bannerFor('ANNOUNCEMENT', false)).toBe(false);
    expect(bannerFor('RELEASE_NOTE', false)).toBe(false);
    expect(bannerFor('RELEASE_NOTE', true)).toBe(true);
  });

  it('reaches institutions with people, suspended ones included, by the audience chosen', () => {
    const tenants = [
      { id: 'a', status: 'ACTIVE', releaseRing: 'PILOT' },
      { id: 'b', status: 'ACTIVE', releaseRing: 'GENERAL' },
      { id: 'c', status: 'SUSPENDED', releaseRing: 'PILOT' },
      { id: 'd', status: 'ONBOARDING', releaseRing: 'GENERAL' },
      { id: 'e', status: 'REQUESTED', releaseRing: 'PILOT' },
      { id: 'f', status: 'ARCHIVED', releaseRing: 'GENERAL' },
    ] as const;
    expect(audienceOf({ audience: 'ALL', ring: null, tenantIds: [] }, tenants)).toEqual(['a', 'b', 'c', 'd']);
    expect(audienceOf({ audience: 'RING', ring: 'PILOT', tenantIds: [] }, tenants)).toEqual(['a', 'c']);
    expect(audienceOf({ audience: 'TENANTS', ring: null, tenantIds: ['b', 'e', 'zz'] }, tenants)).toEqual(['b']);
  });

  it('lets OWNER, SUPER_ADMIN and SUPPORT publish, and only OWNER and SUPER_ADMIN set a ring, each with a step-up (Q1)', () => {
    const holders = (p: 'platform.notice.publish' | 'platform.release.manage') =>
      Object.entries(PLATFORM_ROLE_PERMISSIONS)
        .filter(([, ps]) => ps.includes(p))
        .map(([r]) => r);
    expect(holders('platform.notice.publish')).toEqual(['OWNER', 'SUPER_ADMIN', 'SUPPORT']);
    expect(holders('platform.release.manage')).toEqual(['OWNER', 'SUPER_ADMIN']);
    expect(PLATFORM_PERMISSION_CATALOG['platform.notice.publish'].stepUp).toBe(true);
    expect(PLATFORM_PERMISSION_CATALOG['platform.release.manage'].stepUp).toBe(true);
  });
});
