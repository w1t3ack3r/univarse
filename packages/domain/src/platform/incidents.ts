/**
 * Spec 0037 Q13, Q14 (E19, docs/14, docs/16 §8): incidents. Pure, so the rules are tested without a database. An
 * incident's timeline is its record: each change is an update, never edited. Public text goes to the affected
 * institutions; an internal note never leaves the console. When personal data may be involved, the 72-hour clock runs
 * from when we became aware; the system sends no notification itself (the institution is the controller).
 */
export const INCIDENT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const PERSONAL_DATA = ['YES', 'NO', 'UNKNOWN'] as const;
export type PersonalData = (typeof PERSONAL_DATA)[number];

export const INCIDENT_TITLE_MAX = 120;
export const INCIDENT_PUBLIC_MAX = 1_000;
export const INCIDENT_NOTE_MAX = 2_000;
export const INCIDENT_FOLLOWUP_MAX = 4_000;
/** Q14: a resolved incident still shows at the institutions for a day, then leaves. */
export const RESOLVED_SHOWN_MS = 24 * 3_600_000;
/** docs/16 §8: a breach is reported within 72 hours of becoming aware of it. */
export const BREACH_CLOCK_MS = 72 * 3_600_000;

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

export type IncidentProblem = 'title_length' | 'text_length' | 'note_length' | 'control_characters' | 'tenants_required' | 'aware_before_start' | 'in_the_future';

/** What an incident's opening must hold, as [field, problem] pairs; none means it may be opened. */
export function openingProblems(
  o: { title: string; publicText: string; internalNote: string | null; scope: 'ALL' | 'TENANTS'; tenantIds: readonly string[]; startedAt: Date; awareAt: Date },
  now: Date,
): (readonly [field: string, problem: IncidentProblem])[] {
  const out: (readonly [string, IncidentProblem])[] = [];
  const title = o.title.trim();
  if (title.length < 3 || title.length > INCIDENT_TITLE_MAX) out.push(['title', 'title_length']);
  // A title is one line: it shows as a banner's heading at every affected institution.
  if (CONTROL.test(o.title) || /[\r\n\t]/.test(o.title)) out.push(['title', 'control_characters']);
  out.push(...updateProblems({ publicText: o.publicText, internalNote: o.internalNote }));
  if (o.scope === 'TENANTS' && o.tenantIds.length === 0) out.push(['tenantIds', 'tenants_required']);
  if (o.startedAt.getTime() > now.getTime() + 60_000) out.push(['startedAt', 'in_the_future']);
  if (o.awareAt.getTime() > now.getTime() + 60_000) out.push(['awareAt', 'in_the_future']);
  if (o.awareAt.getTime() < o.startedAt.getTime()) out.push(['awareAt', 'aware_before_start']);
  return out;
}

/** What an update must hold: public text for the institutions, and an optional staff-only note. */
export function updateProblems(u: { publicText: string; internalNote: string | null }): (readonly [field: string, problem: IncidentProblem])[] {
  const out: (readonly [string, IncidentProblem])[] = [];
  const text = u.publicText.trim();
  if (text.length < 3 || text.length > INCIDENT_PUBLIC_MAX) out.push(['publicText', 'text_length']);
  if (CONTROL.test(u.publicText)) out.push(['publicText', 'control_characters']);
  const note = u.internalNote?.trim() ?? '';
  if (note.length > INCIDENT_NOTE_MAX) out.push(['internalNote', 'note_length']);
  if (CONTROL.test(u.internalNote ?? '')) out.push(['internalNote', 'control_characters']);
  return out;
}

/** A resolved incident is final: a recurrence is a new incident. Any open status may move to any other. */
export const updatable = (status: IncidentStatus): boolean => status !== 'RESOLVED';

/** Q14: whether an incident shows at its institutions now: while open, and for a day after it's resolved. */
export function incidentShows(i: { status: IncidentStatus; resolvedAt: Date | null }, now: Date): boolean {
  if (i.status !== 'RESOLVED') return true;
  return i.resolvedAt !== null && now.getTime() - i.resolvedAt.getTime() < RESOLVED_SHOWN_MS;
}

/**
 * docs/16 §8: when personal data may be involved (yes, or not yet known), the 72-hour clock from awareness: its
 * deadline, or null when no personal data is involved.
 */
export function breachDeadline(i: { personalData: PersonalData; awareAt: Date }): Date | null {
  return i.personalData === 'NO' ? null : new Date(i.awareAt.getTime() + BREACH_CLOCK_MS);
}
