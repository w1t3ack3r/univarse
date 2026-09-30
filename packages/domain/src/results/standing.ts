import { Decimal } from 'decimal.js';
import { DomainError } from '../errors.js';

export type AcademicStanding = 'GOOD' | 'PROBATION' | 'WITHDRAWAL_RECOMMENDED';

export interface StandingPolicy {
  /** CGPA strictly below this puts a student on probation. Default "1.00". */
  readonly probationBelow: string;
}

/**
 * End-of-session standing recommendation. A withdrawal is only ever *recommended*;
 * a human records the status change. Rule: docs/04-business-rules.md §3
 */
export function evaluateStanding(input: {
  cgpa: string | null;
  previousStanding: AcademicStanding;
  policy: StandingPolicy;
}): AcademicStanding {
  if (input.cgpa === null) return input.previousStanding;
  if (new Decimal(input.cgpa).gte(input.policy.probationBelow)) return 'GOOD';
  return input.previousStanding === 'GOOD' ? 'PROBATION' : 'WITHDRAWAL_RECOMMENDED';
}

export interface DegreeClassBand {
  readonly minCgpa: string;
  readonly key: string;
  readonly label: string;
}

/** Degree classification from final (already rounded) CGPA. Rule: docs/04-business-rules.md §4 */
export function classifyDegree(cgpa: string, bands: readonly DegreeClassBand[]): DegreeClassBand | null {
  if (bands.length === 0) throw new DomainError('graduation.invalid_class_bands', 'No class bands');
  const value = new Decimal(cgpa);
  const sorted = [...bands].sort((a, b) => new Decimal(b.minCgpa).cmp(a.minCgpa));
  return sorted.find((b) => value.gte(b.minCgpa)) ?? null;
}
