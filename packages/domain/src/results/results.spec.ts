import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEGREE_CLASSES,
  DEFAULT_RESULT_POLICY,
  NUC_FIVE_POINT_NO_E_SCHEME,
  NUC_FIVE_POINT_SCHEME,
} from './defaults.js';
import { computeSemesterResult } from './gpa.js';
import { assertValidScheme, gradeScore } from './grading.js';
import { classifyDegree, evaluateStanding } from './standing.js';
import type { CourseAttempt, GradingScheme, ResultPolicy } from './types.js';

const policy = DEFAULT_RESULT_POLICY;
const scheme = NUC_FIVE_POINT_SCHEME;

function attempt(courseId: string, cu: number, total: number, semesterSeq: number): CourseAttempt {
  const g = gradeScore({ total }, scheme, policy);
  return { courseId, creditUnits: cu, semesterSeq, gradePoint: g.gradePoint, isPass: g.isPass, countsInGpa: g.countsInGpa };
}

describe('grading', () => {
  it('default schemes are valid', () => {
    expect(() => assertValidScheme(NUC_FIVE_POINT_SCHEME)).not.toThrow();
    expect(() => assertValidScheme(NUC_FIVE_POINT_NO_E_SCHEME)).not.toThrow();
  });

  it.each([
    [100, 'A', 5], [70, 'A', 5], [69.5, 'A', 5], [69.49, 'B', 4], [60, 'B', 4],
    [50, 'C', 3], [45, 'D', 2], [44.5, 'D', 2], [40, 'E', 1], [39.5, 'E', 1], [39.4, 'F', 0], [0, 'F', 0],
  ])('score %s → %s (%s GP) with half-up integer rounding', (total, grade, gp) => {
    const g = gradeScore({ total }, scheme, policy);
    expect([g.grade, g.gradePoint]).toEqual([grade, gp]);
  });

  it('truncation rounding grades 69.9 as B', () => {
    const g = gradeScore({ total: 69.9 }, scheme, { ...policy, scoreRounding: 'TRUNCATE_INTEGER' });
    expect(g.grade).toBe('B');
  });

  it('scheme without E fails 40–44', () => {
    expect(gradeScore({ total: 42 }, NUC_FIVE_POINT_NO_E_SCHEME, policy).grade).toBe('F');
  });

  it('ABS is graded as F and counts; INC is excluded', () => {
    expect(gradeScore({ total: null, remark: 'ABS' }, scheme, policy)).toMatchObject({ grade: 'F', gradePoint: 0, countsInGpa: true });
    expect(gradeScore({ total: null, remark: 'INC' }, scheme, policy)).toMatchObject({ grade: null, countsInGpa: false });
  });

  it('rejects out-of-range scores and unknown remarks', () => {
    expect(() => gradeScore({ total: 101 }, scheme, policy)).toThrow(/between 0 and 100/);
    expect(() => gradeScore({ total: -1 }, scheme, policy)).toThrow();
    expect(() => gradeScore({ total: null, remark: 'XYZ' }, scheme, policy)).toThrow(/Unknown remark/);
    expect(() => gradeScore({ total: null }, scheme, policy)).toThrow(/required/);
  });
});

describe('scheme validation', () => {
  const base = NUC_FIVE_POINT_SCHEME;
  const withBands = (bands: GradingScheme['bands'], failGrade = 'F'): GradingScheme => ({ ...base, bands, failGrade });
  it.each<[string, GradingScheme, RegExp]>([
    ['no bands', withBands([]), /no bands/],
    ['duplicate mins', withBands([...base.bands, { minScore: 70, grade: 'A+', gradePoint: 5, isPass: true }]), /Duplicate/],
    ['not covering 0', withBands(base.bands.filter((b) => b.minScore !== 0)), /cover a score of 0/],
    ['band out of range', withBands([...base.bands, { minScore: 101, grade: 'X', gradePoint: 5, isPass: true }]), /out of range/],
    ['grade point out of range', withBands(base.bands.map((b) => (b.grade === 'A' ? { ...b, gradePoint: 6 } : b))), /Grade point/],
    ['decreasing points', withBands(base.bands.map((b) => (b.grade === 'F' ? { ...b, gradePoint: 3 } : b))), /must not decrease/],
    ['failGrade not failing', withBands(base.bands, 'A'), /failGrade/],
  ])('rejects %s', (_label, scheme, err) => {
    expect(() => assertValidScheme(scheme)).toThrow(err);
  });

  it('NONE rounding grades on the exact decimal', () => {
    expect(gradeScore({ total: '69.99' }, scheme, { ...policy, scoreRounding: 'NONE' })).toMatchObject({ grade: 'B', score: '69.99' });
  });
});

describe('engine input validation and pending results', () => {
  const ok: CourseAttempt = { courseId: 'C1', creditUnits: 3, semesterSeq: 1, gradePoint: 5, isPass: true, countsInGpa: true };
  it('rejects invalid credit units and missing grade points', () => {
    expect(() => computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: [{ ...ok, creditUnits: 2.5 }] })).toThrow(/credit units/);
    expect(() => computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: [{ ...ok, gradePoint: null }] })).toThrow(/grade point/);
  });
  it('excluded (INC) results are pending and do not affect GPA; empty semester has null GPA', () => {
    const inc: CourseAttempt = { courseId: 'C2', creditUnits: 3, semesterSeq: 1, gradePoint: null, isPass: false, countsInGpa: false };
    const r = computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: [ok, inc] });
    expect(r).toMatchObject({ tcu: 3, gpa: '5.00', pendingCourseIds: ['C2'], outstandingCourseIds: [] });
    expect(computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: [inc] })).toMatchObject({ gpa: null, cgpa: null });
  });
  it('LATEST_ATTEMPT keeps only the most recent attempt', () => {
    const r = computeSemesterResult({
      policy: { ...policy, repeatPolicy: 'LATEST_ATTEMPT' },
      priorAttempts: [{ ...ok, gradePoint: 5 }],
      semesterAttempts: [{ ...ok, semesterSeq: 2, gradePoint: 2 }],
    });
    expect(r).toMatchObject({ cumulativeTcu: 3, cgpa: '2.00' });
  });
  it('excludeFromGpa courses earn no GPA weight', () => {
    const r = computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: [ok, { ...ok, courseId: 'GST', excludeFromGpa: true, gradePoint: 0 }] });
    expect(r).toMatchObject({ tcu: 3, gpa: '5.00' });
  });
});

describe('fixture gpa-basic-01 (docs/04-business-rules.md §2.2)', () => {
  const sem1 = [
    attempt('CSC101', 3, 72, 1),
    attempt('MTH101', 3, 55, 1),
    attempt('PHY101', 2, 38, 1),
    attempt('GST111', 2, 64, 1),
  ];

  it('semester 1: TCU 10, TCP 32, GPA 3.20, PHY101 outstanding', () => {
    const r = computeSemesterResult({ policy, priorAttempts: [], semesterAttempts: sem1 });
    expect(r).toMatchObject({ tcu: 10, tcp: 32, gpa: '3.20', cgpa: '3.20', outstandingCourseIds: ['PHY101'] });
  });

  it('semester 2 with PHY101 retaken (B): CGPA 90/26 = 3.46 under ALL_ATTEMPTS_COUNT', () => {
    const sem2 = [
      attempt('PHY101', 2, 62, 2), // B → 8
      attempt('CSC102', 3, 75, 2), // A → 15
      attempt('MTH102', 3, 61, 2), // B → 12
      attempt('STA102', 3, 66, 2), // B → 12
      attempt('CHM102', 3, 52, 2), // C → 9
      attempt('GST112', 2, 42, 2), // E → 2   (others: 14 CU, 50 CP as in the doc)
    ];
    const others = sem2.slice(1);
    expect(others.reduce((s, a) => s + a.creditUnits, 0)).toBe(14);
    expect(others.reduce((s, a) => s + a.creditUnits * a.gradePoint!, 0)).toBe(50);

    const r = computeSemesterResult({ policy, priorAttempts: sem1, semesterAttempts: sem2 });
    // Semester: 58/16 = 3.625 → 3.63. Cumulative: (32 + 50 + 8) / (10 + 14 + 2) = 90/26 = 3.4615 → 3.46
    expect(r).toMatchObject({ tcu: 16, tcp: 58, gpa: '3.63', cumulativeTcu: 26, cumulativeTcp: 90, cgpa: '3.46' });
    expect(r.outstandingCourseIds).toEqual([]);
  });

  it('BEST_ATTEMPT drops the original F from CGPA', () => {
    const retake = [attempt('PHY101', 2, 62, 2)];
    const r = computeSemesterResult({
      policy: { ...policy, repeatPolicy: 'BEST_ATTEMPT' },
      priorAttempts: sem1,
      semesterAttempts: retake,
    });
    expect(r).toMatchObject({ cumulativeTcu: 10, cumulativeTcp: 40, cgpa: '4.00' });
  });
});

describe('rounding at class boundaries', () => {
  it('half-up vs truncate can change the class (4.496 → 4.50 First vs 4.49 2:1)', () => {
    const mk = (id: string, cu: number, gp: number): CourseAttempt => ({
      courseId: id, creditUnits: cu, semesterSeq: 1, gradePoint: gp, isPass: true, countsInGpa: true,
    });
    const set = [mk('A1', 62, 5), mk('B1', 63, 4)]; // (310 + 252) / 125 = 4.496
    const cases: [ResultPolicy['gpaRounding'], string][] = [['ROUND_HALF_UP_2DP', '4.50'], ['TRUNCATE_2DP', '4.49']];
    for (const [mode, expected] of cases) {
      const r = computeSemesterResult({ policy: { ...policy, gpaRounding: mode }, priorAttempts: [], semesterAttempts: set });
      expect(r.cgpa).toBe(expected);
    }
    expect(classifyDegree('4.50', DEFAULT_DEGREE_CLASSES)?.key).toBe('FIRST');
    expect(classifyDegree('4.49', DEFAULT_DEGREE_CLASSES)?.key).toBe('SECOND_UPPER');
  });
});

describe('standing and classification', () => {
  const p = { probationBelow: '1.00' };
  it('probation then withdrawal recommendation', () => {
    expect(evaluateStanding({ cgpa: '0.95', previousStanding: 'GOOD', policy: p })).toBe('PROBATION');
    expect(evaluateStanding({ cgpa: '0.99', previousStanding: 'PROBATION', policy: p })).toBe('WITHDRAWAL_RECOMMENDED');
    expect(evaluateStanding({ cgpa: '1.00', previousStanding: 'PROBATION', policy: p })).toBe('GOOD');
  });
  it('keeps the previous standing when there is no CGPA yet', () => {
    expect(evaluateStanding({ cgpa: null, previousStanding: 'PROBATION', policy: p })).toBe('PROBATION');
  });
  it('rejects empty class bands', () => {
    expect(() => classifyDegree('3.00', [])).toThrow(/No class bands/);
  });
  it('classifies boundaries and returns null below Pass', () => {
    expect(classifyDegree('3.50', DEFAULT_DEGREE_CLASSES)?.key).toBe('SECOND_UPPER');
    expect(classifyDegree('2.39', DEFAULT_DEGREE_CLASSES)?.key).toBe('THIRD');
    expect(classifyDegree('0.99', DEFAULT_DEGREE_CLASSES)).toBeNull();
  });
});

// Property tests are CPU-heavy: 6.6 s under a fully parallel turbo run (2026-10-07), past the 5 s default.
describe('properties', { timeout: 30_000 }, () => {
  // Prior attempts in semesters 1–7, current in semester 8; unique (course, semester) pairs.
  const arbHistory = (seqMin: number, seqMax: number) =>
    fc
      .uniqueArray(
        fc.record({
          courseId: fc.constantFrom('C1', 'C2', 'C3', 'C4', 'C5', 'C6'),
          creditUnits: fc.integer({ min: 1, max: 6 }),
          semesterSeq: fc.integer({ min: seqMin, max: seqMax }),
          total: fc.integer({ min: 0, max: 100 }),
        }),
        { minLength: 1, maxLength: 20, selector: (a) => `${a.courseId}@${a.semesterSeq}` },
      )
      .map((xs) => xs.map((a) => attempt(a.courseId, a.creditUnits, a.total, a.semesterSeq)));
  const arbAttempts = arbHistory(1, 7);
  const arbCurrent = arbHistory(8, 8);
  const policies = fc.constantFrom<ResultPolicy['repeatPolicy']>('ALL_ATTEMPTS_COUNT', 'BEST_ATTEMPT', 'LATEST_ATTEMPT');

  it('rejects the same course twice in one semester', () => {
    const a = attempt('C1', 3, 70, 1);
    expect(() => computeSemesterResult({ policy, priorAttempts: [a], semesterAttempts: [a] })).toThrow(/twice/);
  });

  it('GPA and CGPA stay within 0–5', () => {
    fc.assert(fc.property(arbAttempts, arbCurrent, policies, (prior, cur, rp) => {
      const r = computeSemesterResult({ policy: { ...policy, repeatPolicy: rp }, priorAttempts: prior, semesterAttempts: cur });
      for (const v of [r.gpa, r.cgpa]) {
        if (v === null) continue;
        expect(Number(v)).toBeGreaterThanOrEqual(0);
        expect(Number(v)).toBeLessThanOrEqual(5);
      }
    }));
  });

  it('order of courses does not change results', () => {
    fc.assert(fc.property(arbAttempts, arbCurrent, policies, (prior, cur, rp) => {
      const pol = { ...policy, repeatPolicy: rp };
      const a = computeSemesterResult({ policy: pol, priorAttempts: prior, semesterAttempts: cur });
      const b = computeSemesterResult({ policy: pol, priorAttempts: [...prior].reverse(), semesterAttempts: [...cur].reverse() });
      expect(b).toEqual(a);
    }));
  });

  it('adding an A never lowers CGPA; adding an F never raises it (ALL_ATTEMPTS_COUNT)', () => {
    fc.assert(fc.property(arbAttempts, fc.integer({ min: 1, max: 6 }), (prior, cu) => {
      const base = computeSemesterResult({ policy, priorAttempts: prior, semesterAttempts: [] });
      const withA = computeSemesterResult({ policy, priorAttempts: prior, semesterAttempts: [attempt('NEW', cu, 80, 9)] });
      const withF = computeSemesterResult({ policy, priorAttempts: prior, semesterAttempts: [attempt('NEW', cu, 10, 9)] });
      const exact = (r: typeof base) => r.cumulativeTcp / r.cumulativeTcu;
      expect(exact(withA)).toBeGreaterThanOrEqual(exact(base));
      expect(exact(withF)).toBeLessThanOrEqual(exact(base));
    }));
  });
});
