// Common NUC-aligned defaults. `[VERIFY]` against each tenant's Senate-approved regulations.
// Rules: docs/04-business-rules.md §1, §2, §4
import type { DegreeClassBand } from './standing.js';
import type { GradingScheme, ResultPolicy } from './types.js';

export const NUC_FIVE_POINT_SCHEME: GradingScheme = {
  id: 'nuc-5pt-with-e',
  name: 'NUC 5-point (with E)',
  failGrade: 'F',
  bands: [
    { minScore: 70, grade: 'A', gradePoint: 5, isPass: true },
    { minScore: 60, grade: 'B', gradePoint: 4, isPass: true },
    { minScore: 50, grade: 'C', gradePoint: 3, isPass: true },
    { minScore: 45, grade: 'D', gradePoint: 2, isPass: true },
    { minScore: 40, grade: 'E', gradePoint: 1, isPass: true },
    { minScore: 0, grade: 'F', gradePoint: 0, isPass: false },
  ],
};

export const NUC_FIVE_POINT_NO_E_SCHEME: GradingScheme = {
  id: 'nuc-5pt-no-e',
  name: 'NUC 5-point (no E, pass mark 45)',
  failGrade: 'F',
  // Without the E band, 40–44 falls through to F.
  bands: NUC_FIVE_POINT_SCHEME.bands.filter((b) => b.grade !== 'E'),
};

export const DEFAULT_RESULT_POLICY: ResultPolicy = {
  scoreRounding: 'ROUND_HALF_UP_INTEGER',
  gpaRounding: 'ROUND_HALF_UP_2DP',
  repeatPolicy: 'ALL_ATTEMPTS_COUNT',
  remarkTreatments: { ABS: 'AS_F', INC: 'EXCLUDE', SICK: 'EXCLUDE', MAL: 'EXCLUDE', NR: 'EXCLUDE' },
};

export const DEFAULT_DEGREE_CLASSES: readonly DegreeClassBand[] = [
  { minCgpa: '4.50', key: 'FIRST', label: 'First Class' },
  { minCgpa: '3.50', key: 'SECOND_UPPER', label: 'Second Class (Upper Division)' },
  { minCgpa: '2.40', key: 'SECOND_LOWER', label: 'Second Class (Lower Division)' },
  { minCgpa: '1.50', key: 'THIRD', label: 'Third Class' },
  { minCgpa: '1.00', key: 'PASS', label: 'Pass' },
];
