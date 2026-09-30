// Result-processing types. Rules: docs/04-business-rules.md §1–4.

/** How a raw total score is rounded before grading. `[CONFIG results.scoreRounding]` */
export type ScoreRounding = 'ROUND_HALF_UP_INTEGER' | 'TRUNCATE_INTEGER' | 'NONE';

/** How GPA/CGPA is rounded for display and classification. `[CONFIG results.gpaRounding]` */
export type GpaRounding = 'ROUND_HALF_UP_2DP' | 'TRUNCATE_2DP';

/** Which attempts of a repeated course count toward CGPA. `[CONFIG results.repeatPolicy]` */
export type RepeatPolicy = 'ALL_ATTEMPTS_COUNT' | 'BEST_ATTEMPT' | 'LATEST_ATTEMPT';

/** How a remark code affects grading. `[CONFIG]` via ResultRemarkCode. */
export type RemarkTreatment = 'AS_F' | 'EXCLUDE';

export interface GradeBand {
  /** Inclusive lower bound on the (rounded) total score. */
  readonly minScore: number;
  readonly grade: string;
  readonly gradePoint: number;
  readonly isPass: boolean;
}

export interface GradingScheme {
  readonly id: string;
  readonly name: string;
  /** Any order; validated to be non-overlapping and to cover 0. */
  readonly bands: readonly GradeBand[];
  /** Grade assigned when a remark is treated `AS_F`. */
  readonly failGrade: string;
}

export interface ResultPolicy {
  readonly scoreRounding: ScoreRounding;
  readonly gpaRounding: GpaRounding;
  readonly repeatPolicy: RepeatPolicy;
  /** Remark code → treatment. Unknown codes are rejected. */
  readonly remarkTreatments: Readonly<Record<string, RemarkTreatment>>;
}

export interface ScoreInput {
  /** Total score 0–100 as a decimal string or number, or null when a remark applies. */
  readonly total: string | number | null;
  readonly remark?: string | null;
}

export interface GradedScore {
  /** Rounded score used for grading (string, 2dp), or null when excluded without a score. */
  readonly score: string | null;
  readonly grade: string | null;
  readonly gradePoint: number | null;
  readonly isPass: boolean;
  /** False when the result is excluded from GPA (e.g. INC, SICK, MAL, NR). */
  readonly countsInGpa: boolean;
  readonly remark: string | null;
}

/** One attempt of a course, as produced by grading and publication. */
export interface CourseAttempt {
  readonly courseId: string;
  readonly creditUnits: number;
  /** Monotonic semester ordering index (e.g. 20251 for 2025/2026 first semester). */
  readonly semesterSeq: number;
  readonly gradePoint: number | null;
  readonly isPass: boolean;
  readonly countsInGpa: boolean;
  /** Courses like some GST/pass-fail ones earn units but never count in GPA. */
  readonly excludeFromGpa?: boolean;
}

export interface SemesterComputation {
  readonly tcu: number;
  readonly tcp: number;
  /** null when no GPA-bearing units in the semester. */
  readonly gpa: string | null;
  readonly cumulativeTcu: number;
  readonly cumulativeTcp: number;
  readonly cgpa: string | null;
  /** Course IDs failed and not (yet) passed in any counted attempt. */
  readonly outstandingCourseIds: readonly string[];
  /** Courses with a pending/excluded result in this semester (INC, SICK, MAL, NR…). */
  readonly pendingCourseIds: readonly string[];
  readonly engineVersion: string;
}
