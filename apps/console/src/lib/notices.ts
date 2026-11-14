// Spec 0037 Q9, Q12: what staff read about notices and rings instead of their machine names.
import type { PlatformNoticeSummary } from '@univarse/contracts';

export const NOTICE_KIND: Readonly<Record<PlatformNoticeSummary['kind'], { label: string; banner: string; about: string }>> = {
  ANNOUNCEMENT: { label: 'Announcement', banner: 'From UniVarse', about: 'Shown to each institution’s IT Admins for 14 days.' },
  MAINTENANCE: { label: 'Maintenance', banner: 'Planned maintenance', about: 'Shown to everyone there, on the sign-in page too, until the window ends.' },
  RELEASE_NOTE: { label: 'Release note', banner: 'What’s new', about: 'Shown to each institution’s IT Admins for 14 days.' },
};

export const RING: Readonly<Record<'PILOT' | 'GENERAL', { label: string; about: string }>> = {
  PILOT: { label: 'Pilot', about: 'Gets new releases and their notes first.' },
  GENERAL: { label: 'General', about: 'Gets releases once the pilot has had them.' },
};

/** Who a notice is for, in words. */
export function audienceText(n: Pick<PlatformNoticeSummary, 'audience' | 'ring' | 'institutions' | 'status'>): string {
  if (n.audience === 'ALL') return n.status === 'DRAFT' ? 'Every institution' : `Every institution (${String(n.institutions)})`;
  if (n.audience === 'RING') return `The ${n.ring ? RING[n.ring].label.toLowerCase() : ''} ring${n.status === 'DRAFT' ? '' : ` (${String(n.institutions)})`}`;
  return n.institutions === 1 ? '1 chosen institution' : `${String(n.institutions)} chosen institutions`;
}

export function noticeState(n: Pick<PlatformNoticeSummary, 'status' | 'live' | 'publishedAt'>): { text: string; tone: string } {
  if (n.status === 'DRAFT') return { text: 'Draft', tone: 'pc-status--none' };
  if (n.status === 'WITHDRAWN') return { text: n.publishedAt ? 'Withdrawn' : 'Discarded', tone: 'pc-status--off' };
  return n.live ? { text: 'Showing', tone: 'pc-status--on' } : { text: 'Ended', tone: 'pc-status--off' };
}

/** What stops a draft being published, as staff read it (packages/domain noticeProblems). */
export const NOTICE_PROBLEM: Readonly<Record<string, string>> = {
  title_length: 'The title needs 3 to 120 characters.',
  body_length: 'The message needs 3 to 2,000 characters.',
  control_characters: 'Remove the invisible control characters (they can disguise text).',
  ring_required: 'Choose a ring.',
  tenants_required: 'Choose at least one institution.',
  too_many_tenants: 'Choose at most 200 institutions, or send it to everyone or a ring.',
  window_required: 'Maintenance needs a start and an end.',
  window_order: 'The window has to end after it starts.',
  window_past: 'The window has already ended.',
  window_too_long: 'A maintenance window is at most a week. Longer is an incident.',
  window_not_maintenance: 'Only maintenance has a window.',
};

const LAGOS = 'Africa/Lagos';
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** An instant as a `datetime-local` value in Nigerian time (UTC+1, no daylight saving). */
export function toLagosInput(iso: string | null): string {
  if (!iso) return '';
  const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''}T${p.hour ?? ''}:${p.minute ?? ''}`;
}

/** A `datetime-local` value, read as Nigerian time, as an instant; null when empty or malformed. */
export function fromLagosInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(`${value}:00+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
