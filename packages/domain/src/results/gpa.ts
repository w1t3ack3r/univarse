import { Decimal } from 'decimal.js';
import { DomainError } from '../errors.js';
import type { CourseAttempt, GpaRounding, RepeatPolicy, ResultPolicy, SemesterComputation } from './types.js';

/** Bump when the computation semantics change; stored on every SemesterResult. */
export const RESULTS_ENGINE_VERSION = '1.0.0';

export function roundGpa(value: Decimal, mode: GpaRounding): string {
  const rm = mode === 'ROUND_HALF_UP_2DP' ? Decimal.ROUND_HALF_UP : Decimal.ROUND_DOWN;
  return value.toDecimalPlaces(2, rm).toFixed(2);
}

export type GpaBearingAttempt = CourseAttempt & { readonly gradePoint: number };

function isGpaBearing(a: CourseAttempt): a is GpaBearingAttempt {
  return a.countsInGpa && !a.excludeFromGpa && a.gradePoint !== null;
}

function totals(attempts: readonly GpaBearingAttempt[]): { tcu: number; tcp: Decimal } {
  let tcu = 0;
  let tcp = new Decimal(0);
  for (const a of attempts) {
    tcu += a.creditUnits;
    tcp = tcp.plus(new Decimal(a.gradePoint).times(a.creditUnits));
  }
  return { tcu, tcp };
}

/** Selects the attempts that count toward CGPA. Rule: docs/04-business-rules.md §2.1 */
export function selectCountedAttempts(
  attempts: readonly CourseAttempt[],
  policy: RepeatPolicy,
): GpaBearingAttempt[] {
  const bearing = attempts.filter(isGpaBearing);
  if (policy === 'ALL_ATTEMPTS_COUNT') return bearing;

  const byCourse = new Map<string, GpaBearingAttempt>();
  for (const a of bearing) {
    const cur = byCourse.get(a.courseId);
    if (!cur) {
      byCourse.set(a.courseId, a);
      continue;
    }
    const better =
      policy === 'LATEST_ATTEMPT'
        ? a.semesterSeq > cur.semesterSeq
        : a.gradePoint > cur.gradePoint ||
          (a.gradePoint === cur.gradePoint && a.semesterSeq > cur.semesterSeq);
    if (better) byCourse.set(a.courseId, a);
  }
  return [...byCourse.values()];
}

function validate(attempts: readonly CourseAttempt[]): void {
  const seen = new Set<string>();
  for (const a of attempts) {
    const key = `${a.courseId}@${a.semesterSeq}`;
    if (seen.has(key)) {
      throw new DomainError('results.duplicate_attempt', `${a.courseId} attempted twice in one semester`);
    }
    seen.add(key);
    if (!Number.isInteger(a.creditUnits) || a.creditUnits < 0) {
      throw new DomainError('results.invalid_credit_units', `Invalid credit units for ${a.courseId}`);
    }
    if (a.countsInGpa && a.gradePoint === null) {
      throw new DomainError('results.missing_grade_point', `Missing grade point for ${a.courseId}`);
    }
  }
}

/**
 * Computes a semester result and cumulative position. Pure and deterministic.
 * Rules: docs/04-business-rules.md §2 (GPA/CGPA) — fixture `gpa-basic-01` in tests.
 */
export function computeSemesterResult(input: {
  policy: ResultPolicy;
  priorAttempts: readonly CourseAttempt[];
  semesterAttempts: readonly CourseAttempt[];
}): SemesterComputation {
  const { policy, priorAttempts, semesterAttempts } = input;
  const all = [...priorAttempts, ...semesterAttempts];
  validate(all);

  const sem = totals(semesterAttempts.filter(isGpaBearing));
  const cum = totals(selectCountedAttempts(all, policy.repeatPolicy));

  const passed = new Set(all.filter((a) => a.isPass).map((a) => a.courseId));
  const outstanding = new Set(
    all.filter((a) => a.gradePoint !== null && !a.isPass && !passed.has(a.courseId)).map((a) => a.courseId),
  );

  return {
    tcu: sem.tcu,
    tcp: sem.tcp.toNumber(),
    gpa: sem.tcu === 0 ? null : roundGpa(sem.tcp.div(sem.tcu), policy.gpaRounding),
    cumulativeTcu: cum.tcu,
    cumulativeTcp: cum.tcp.toNumber(),
    cgpa: cum.tcu === 0 ? null : roundGpa(cum.tcp.div(cum.tcu), policy.gpaRounding),
    outstandingCourseIds: [...outstanding].sort(),
    pendingCourseIds: semesterAttempts
      .filter((a) => !a.countsInGpa)
      .map((a) => a.courseId)
      .sort(),
    engineVersion: RESULTS_ENGINE_VERSION,
  };
}
