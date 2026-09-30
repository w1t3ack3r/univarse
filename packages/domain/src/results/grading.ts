import { Decimal } from 'decimal.js';
import { DomainError } from '../errors.js';
import type {
  GradeBand,
  GradedScore,
  GradingScheme,
  ResultPolicy,
  ScoreInput,
  ScoreRounding,
} from './types.js';

/** Validates a grading scheme. Rule: docs/04-business-rules.md §1.1 */
export function assertValidScheme(scheme: GradingScheme): void {
  if (scheme.bands.length === 0) {
    throw new DomainError('results.invalid_grading_scheme', 'Grading scheme has no bands');
  }
  const mins = scheme.bands.map((b) => b.minScore);
  if (new Set(mins).size !== mins.length) {
    throw new DomainError('results.invalid_grading_scheme', 'Duplicate band lower bounds');
  }
  if (!mins.includes(0)) {
    throw new DomainError('results.invalid_grading_scheme', 'Bands must cover a score of 0');
  }
  for (const b of scheme.bands) {
    if (b.minScore < 0 || b.minScore > 100) {
      throw new DomainError('results.invalid_grading_scheme', `Band ${b.grade} out of range`);
    }
    if (b.gradePoint < 0 || b.gradePoint > 5) {
      throw new DomainError('results.invalid_grading_scheme', `Grade point of ${b.grade} out of range`);
    }
  }
  const sorted = sortBandsDesc(scheme.bands);
  for (let i = 1; i < sorted.length; i++) {
    // Higher scores must never earn fewer grade points.
    if (sorted[i]!.gradePoint > sorted[i - 1]!.gradePoint) {
      throw new DomainError('results.invalid_grading_scheme', 'Grade points must not decrease as scores rise');
    }
  }
  if (!scheme.bands.some((b) => b.grade === scheme.failGrade && !b.isPass)) {
    throw new DomainError('results.invalid_grading_scheme', 'failGrade must be a failing band');
  }
}

export function roundScore(total: Decimal, mode: ScoreRounding): Decimal {
  switch (mode) {
    case 'ROUND_HALF_UP_INTEGER':
      return total.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    case 'TRUNCATE_INTEGER':
      return total.toDecimalPlaces(0, Decimal.ROUND_DOWN);
    case 'NONE':
      return total;
  }
}

function sortBandsDesc(bands: readonly GradeBand[]): GradeBand[] {
  return [...bands].sort((a, b) => b.minScore - a.minScore);
}

function bandFor(score: Decimal, scheme: GradingScheme): GradeBand {
  const band = sortBandsDesc(scheme.bands).find((b) => score.gte(b.minScore));
  if (!band) throw new DomainError('results.invalid_score', `No band for score ${score.toString()}`);
  return band;
}

/**
 * Grades one score entry, applying rounding and remark treatment.
 * Rule: docs/04-business-rules.md §1.2–1.3
 */
export function gradeScore(input: ScoreInput, scheme: GradingScheme, policy: ResultPolicy): GradedScore {
  const remark = input.remark ?? null;

  if (remark !== null) {
    const treatment = policy.remarkTreatments[remark];
    if (!treatment) throw new DomainError('results.unknown_remark_code', `Unknown remark code ${remark}`);
    if (treatment === 'EXCLUDE') {
      return { score: null, grade: null, gradePoint: null, isPass: false, countsInGpa: false, remark };
    }
    const fail = scheme.bands.find((b) => b.grade === scheme.failGrade)!;
    return { score: '0.00', grade: fail.grade, gradePoint: fail.gradePoint, isPass: false, countsInGpa: true, remark };
  }

  if (input.total === null) {
    throw new DomainError('results.missing_score', 'A score or a remark code is required');
  }
  const raw = new Decimal(input.total);
  if (raw.isNaN() || raw.lt(0) || raw.gt(100)) {
    throw new DomainError('results.invalid_score', 'Score must be between 0 and 100');
  }
  const score = roundScore(raw, policy.scoreRounding);
  const band = bandFor(score, scheme);
  return {
    score: score.toFixed(2),
    grade: band.grade,
    gradePoint: band.gradePoint,
    isPass: band.isPass,
    countsInGpa: true,
    remark: null,
  };
}
