// Spec 0037 Q13, Q14: what staff read about incidents instead of their machine names.
import type { PlatformIncidentSummary } from '@univarse/contracts';

export const SEVERITY: Readonly<Record<PlatformIncidentSummary['severity'], { label: string; about: string; tone: string }>> = {
  SEV1: { label: 'SEV1', about: 'Critical: most institutions can’t work, or data is at risk.', tone: 'pc-status--bad' },
  SEV2: { label: 'SEV2', about: 'Major: a key journey is broken for many.', tone: 'pc-status--bad' },
  SEV3: { label: 'SEV3', about: 'Minor: degraded, with a workaround.', tone: 'pc-status--wait' },
  SEV4: { label: 'SEV4', about: 'Low: cosmetic or a few people.', tone: 'pc-status--none' },
};

export const INCIDENT_STATUS: Readonly<Record<PlatformIncidentSummary['status'], { label: string; about: string; tone: string }>> = {
  INVESTIGATING: { label: 'Investigating', about: 'We know something is wrong and are finding out what.', tone: 'pc-status--bad' },
  IDENTIFIED: { label: 'Identified', about: 'We know the cause and are fixing it.', tone: 'pc-status--wait' },
  MONITORING: { label: 'Monitoring', about: 'A fix is in; we’re watching it holds.', tone: 'pc-status--wait' },
  RESOLVED: { label: 'Resolved', about: 'It’s over. The banner shows for a day, then leaves.', tone: 'pc-status--on' },
};

export const PERSONAL_DATA: Readonly<Record<PlatformIncidentSummary['personalData'], string>> = {
  YES: 'Yes',
  UNKNOWN: 'Not yet known',
  NO: 'No',
};

/** What stops an incident being opened or updated, as staff read it (packages/domain). */
export const INCIDENT_PROBLEM: Readonly<Record<string, string>> = {
  title_length: 'The title needs 3 to 120 characters, on one line.',
  text_length: 'What institutions are told needs 3 to 1,000 characters.',
  note_length: 'The internal note is at most 2,000 characters.',
  control_characters: 'Remove the invisible control characters (they can disguise text).',
  tenants_required: 'Choose at least one institution.',
  aware_before_start: 'We can’t have become aware before it started.',
  in_the_future: 'That time is in the future.',
};

/** "41 h 12 min left", or "Overdue by 3 h": the 72-hour clock, plainly (docs/16 §8). */
export function clockText(deadline: string, now = Date.now()): { text: string; overdue: boolean } {
  const ms = new Date(deadline).getTime() - now;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h > 0 ? `${String(h)} h ${String(m)} min` : `${String(m)} min`;
  return ms >= 0 ? { text: `${span} left`, overdue: false } : { text: `Overdue by ${span}`, overdue: true };
}
