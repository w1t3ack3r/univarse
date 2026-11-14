/**
 * Spec 0037 Q9, Q10, Q12 (E12, E18, T34): notices to institutions, and release rings. Pure, so the rules are tested
 * without a database. A notice is plain text: what it says is shown as text everywhere, never as markup. Once
 * published it never changes; a correction is a new notice, and the old one is withdrawn.
 */
import type { TenantStatusName } from './tenant-registry.js';

export const NOTICE_KINDS = ['ANNOUNCEMENT', 'MAINTENANCE', 'RELEASE_NOTE'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_AUDIENCES = ['ALL', 'TENANTS', 'RING'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];
export const RELEASE_RINGS = ['PILOT', 'GENERAL'] as const;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];
export type NoticeStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';

export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 2_000;
/** How many institutions one notice may name by hand; a wider audience is "every institution" or a ring. */
export const NOTICE_TENANTS_MAX = 200;
/** Q9: an announcement or a release note shows for 14 days unless withdrawn sooner. */
export const NOTICE_SHOWN_FOR_MS = 14 * 24 * 3_600_000;
/** A maintenance window is at most a week: longer is an outage, and an incident (PR D). */
export const MAINTENANCE_MAX_MS = 7 * 24 * 3_600_000;

/**
 * Q10: who sees the banner at an institution. Maintenance concerns everyone there (and shows on its sign-in page);
 * announcements and release notes are for its IT Admins.
 */
export const bannerAudience = (kind: NoticeKind): 'everyone' | 'it_admins' => (kind === 'MAINTENANCE' ? 'everyone' : 'it_admins');

/** The institutions a notice can reach: any that has people. Suspended ones too: their IT Admins should be told (Q8). */
const REACHABLE: ReadonlySet<TenantStatusName> = new Set(['ONBOARDING', 'ACTIVE', 'SUSPENDED']);
export const reachable = (status: TenantStatusName): boolean => REACHABLE.has(status);

export interface NoticeDraft {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly audience: NoticeAudience;
  readonly ring: ReleaseRing | null;
  readonly tenantIds: readonly string[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export type NoticeProblem =
  | 'title_length'
  | 'body_length'
  | 'control_characters'
  | 'ring_required'
  | 'tenants_required'
  | 'too_many_tenants'
  | 'window_required'
  | 'window_order'
  | 'window_past'
  | 'window_too_long'
  | 'window_not_maintenance';

/** Tabs and newlines are text; other control characters (and the bidirectional overrides) are refused. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

/**
 * Every problem with a notice as it would be published, at `now`, as [field, problem] pairs; none means it may be.
 * A draft may be saved with problems; publishing checks again.
 */
export function noticeProblems(n: NoticeDraft, now: Date): (readonly [field: string, problem: NoticeProblem])[] {
  const out: (readonly [string, NoticeProblem])[] = [];
  const title = n.title.trim();
  if (title.length < 3 || title.length > NOTICE_TITLE_MAX) out.push(['title', 'title_length']);
  const body = n.body.trim();
  if (body.length < 3 || body.length > NOTICE_BODY_MAX) out.push(['body', 'body_length']);
  // A title is one line: it becomes an email's subject (Q10), where a line break could start a header.
  if (CONTROL.test(n.title) || /[\r\n\t]/.test(n.title)) out.push(['title', 'control_characters']);
  if (CONTROL.test(n.body)) out.push(['body', 'control_characters']);
  if (n.audience === 'RING' && n.ring === null) out.push(['ring', 'ring_required']);
  if (n.audience === 'TENANTS' && n.tenantIds.length === 0) out.push(['tenantIds', 'tenants_required']);
  if (n.tenantIds.length > NOTICE_TENANTS_MAX) out.push(['tenantIds', 'too_many_tenants']);
  if (n.kind === 'MAINTENANCE') {
    if (!n.startsAt || !n.endsAt) out.push(['startsAt', 'window_required']);
    else {
      if (n.endsAt.getTime() <= n.startsAt.getTime()) out.push(['endsAt', 'window_order']);
      else if (n.endsAt.getTime() - n.startsAt.getTime() > MAINTENANCE_MAX_MS) out.push(['endsAt', 'window_too_long']);
      if (n.endsAt.getTime() <= now.getTime()) out.push(['endsAt', 'window_past']);
    }
  } else if (n.startsAt || n.endsAt) out.push(['startsAt', 'window_not_maintenance']);
  return out;
}

/** Q9: until when a published notice's banner shows, unless withdrawn: the window's end, or 14 days. */
export function shownUntil(kind: NoticeKind, publishedAt: Date, endsAt: Date | null): Date {
  return kind === 'MAINTENANCE' && endsAt ? endsAt : new Date(publishedAt.getTime() + NOTICE_SHOWN_FOR_MS);
}

/** Q9: the institutions a notice reaches, decided once, when it's published, from the registry as it is then. */
export function audienceOf(
  n: Pick<NoticeDraft, 'audience' | 'ring' | 'tenantIds'>,
  tenants: readonly { id: string; status: TenantStatusName; releaseRing: ReleaseRing }[],
): string[] {
  const open = tenants.filter((t) => reachable(t.status));
  if (n.audience === 'ALL') return open.map((t) => t.id);
  if (n.audience === 'RING') return open.filter((t) => t.releaseRing === n.ring).map((t) => t.id);
  const chosen = new Set(n.tenantIds);
  return open.filter((t) => chosen.has(t.id)).map((t) => t.id);
}

export interface Banner {
  readonly kind: NoticeKind;
  readonly shownUntil: Date;
  readonly withdrawn: boolean;
}

/** Q10: whether a published notice's banner shows at `now` (withdrawn ones never do). */
export const bannerShows = (b: Banner, now: Date): boolean => !b.withdrawn && b.shownUntil.getTime() > now.getTime();

/** Q10: whether a person sees a banner: everyone sees maintenance; announcements and release notes are IT Admins'. */
export const bannerFor = (kind: NoticeKind, itAdmin: boolean): boolean => bannerAudience(kind) === 'everyone' || itAdmin;
