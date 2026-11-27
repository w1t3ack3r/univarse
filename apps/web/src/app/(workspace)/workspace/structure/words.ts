// Spec 0042: the Structure page's words. Plain, the institution's own (no "org unit", no "tenant").
import type { ResponseBody } from '@/lib/client-api';

export type Unit = ResponseBody<'/api/v1/org/units', 'get'>['data'][number];
export type UnitType = ResponseBody<'/api/v1/org/unit-types', 'get'>['data'][number];
export type UnitView = ResponseBody<'/api/v1/org/units/{id}', 'get'>;
export type Change = ResponseBody<'/api/v1/org/units/{id}/history', 'get'>['data'][number];
export type State = Unit['state'];

export const STATE_WORD: Record<State, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

export const KIND_WORD: Record<UnitType['kind'], string> = {
  ACADEMIC: 'Academic',
  ADMINISTRATIVE: 'Administrative',
  RESEARCH: 'Research',
};

/** What each change was, as a sentence's start (the history reads "Moved", "Renamed"…). */
export const CHANGE_WORD: Record<Change['kind'], string> = {
  CREATED: 'Created',
  RENAMED: 'Renamed',
  DESCRIBED: 'Description changed',
  RETYPED: 'Type changed',
  MOVED: 'Moved',
  CODE_CHANGED: 'Given a new code',
  CODE_CORRECTED: 'Code corrected',
  DEACTIVATED: 'Deactivated',
  ARCHIVED: 'Archived',
  REACTIVATED: 'Reactivated',
};

const LONG_DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `2026-11-27` as "27 November 2026" (a calendar day: no time zone shifts it). */
export const longDay = (day: string): string => LONG_DAY.format(new Date(`${day}T00:00:00Z`));

/** Today in Nigeria, as the API counts effective dates (spec 0042 Q7). */
export const today = (): string => LAGOS_DAY.format(new Date());

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;
