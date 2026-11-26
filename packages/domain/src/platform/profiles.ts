/**
 * Spec 0041 (P2-S0): the institution-type profiles, the starting data every institution of a type is given (ADR-039).
 * Pure, frozen data: keys are stable lower-case `snake_case` and mean the same thing at every type (Q3); the names are
 * each type's own words. Nothing here is behaviour: later slices project their part into the institution's own
 * editable tables (Q4), and rules that differ are chosen by these keys (a qualification's family), never by the type.
 *
 * Entries marked `verify` depend on the institution's Scheme of Service, conditions of service or enabling law
 * (spec 0040 Q9): they are the owner's guidance documents' descriptions, checked by each institution in S3 and S5.
 */

// ── Shapes

export type UnitKind = 'academic' | 'administrative' | 'research';
export type AwardType = 'degree' | 'diploma' | 'certificate';
export type QualificationFamily =
  | 'bachelor'
  | 'postgraduate_diploma'
  | 'master'
  | 'doctorate'
  | 'diploma'
  | 'certificate'
  | 'nd'
  | 'hnd'
  | 'nid'
  | 'professional_diploma'
  | 'nce'
  | 'pgde'
  | 'nsq';
export type RegulatorKey = 'nuc' | 'nbte' | 'ncce';
export type OfficeScope = 'institution' | 'unit' | 'programme';
export type BodyKind = 'academic' | 'administrative' | 'assembly';
export type BodyFunction = 'governing_body' | 'academic_governing_body' | 'executive_management' | 'unit_academic_board';
export type StageRequirement = 'mandatory' | 'conditional';
/** What switches a conditional stage on. Today one condition: the institution turns the stage on (S5's setting). */
export type StageCondition = 'institution_enables';

export interface Named {
  readonly key: string;
  readonly name: string;
}

export interface ProfileUnitType extends Named {
  readonly kind: UnitKind;
  /** The unit types a unit of this type may contain (Q2's hierarchy rules). The root may contain every type. */
  readonly mayContain: readonly string[];
}

export interface ProfileQualification extends Named {
  /** The short form: "B.Sc.", "HND". */
  readonly abbreviation: string;
  readonly family: QualificationFamily;
  readonly award: AwardType;
  /** In order; a programme of N years uses the first N. */
  readonly levels: readonly string[];
  readonly regulators: readonly RegulatorKey[];
  /** Initial configuration only: never a claim that any programme is approved or accredited (Q9). */
  readonly offered: boolean;
  readonly verify?: true;
}

export interface ProfileRank extends Named {
  /** Other titles for the same rank (Associate Professor and Reader are one rank, not two). */
  readonly alsoTitled?: readonly string[];
}

export interface ProfileCadre extends Named {
  readonly category: string;
  /** In order, lowest first. Empty: the institution adds its own ladder (S3). */
  readonly ranks: readonly ProfileRank[];
  readonly verify?: true;
}

export interface ProfileOffice extends Named {
  readonly scope: OfficeScope;
}

export interface ProfileBody extends Named {
  readonly kind: BodyKind;
  /** The function it holds, which approval chains name; null for an assembly. */
  readonly function: BodyFunction | null;
  readonly scope: 'institution' | 'unit';
  readonly verify: true;
}

export type StageHolder = { readonly office: string } | { readonly function: BodyFunction };

export interface ApprovalStage {
  readonly holder: StageHolder;
  readonly requirement: StageRequirement;
  readonly condition?: StageCondition;
}

export interface ProfileWindowType extends Named {
  /** A window that only makes sense beside a special period (a SIWES application needs a SIWES period). */
  readonly needsPeriod?: string;
}

export interface InstitutionProfile {
  readonly unitTypes: readonly ProfileUnitType[];
  readonly qualifications: readonly ProfileQualification[];
  /** The default academic structure: the semesters a session holds. */
  readonly academicStructure: { readonly semesters: readonly string[] };
  readonly staff: {
    readonly categories: readonly Named[];
    readonly cadres: readonly ProfileCadre[];
    readonly employmentTypes: readonly Named[];
    readonly employmentStatuses: readonly Named[];
  };
  readonly offices: readonly ProfileOffice[];
  readonly governanceBodies: readonly ProfileBody[];
  /** By the thing approved. Later slices add their chains (results) under their own key. */
  readonly approvalChains: { readonly curriculum: readonly ApprovalStage[] };
  readonly periodTypes: readonly Named[];
  readonly windowTypes: readonly ProfileWindowType[];
  readonly regulators: readonly (Named & { readonly key: RegulatorKey })[];
}

// ── Building blocks shared by the three types

/** Deep-freezes a value built from plain objects and arrays. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const named = (pairs: readonly (readonly [string, string])[]): Named[] => pairs.map(([key, name]) => ({ key, name }));

const STAFF_CATEGORIES = named([
  ['academic', 'Academic'],
  ['research', 'Research'],
  ['library', 'Library'],
  ['administrative', 'Administrative'],
  ['finance', 'Finance'],
  ['technical', 'Technical'],
  ['professional', 'Professional'],
  ['medical', 'Medical'],
  ['ict', 'ICT'],
  ['clerical', 'Clerical'],
  ['secretarial', 'Secretarial'],
  ['operational', 'Operational'],
  ['security', 'Security'],
]);

/** Graduate Assistant is a rank here, not also an employment type (spec 0041's appendix). */
const EMPLOYMENT_TYPES = named([
  ['permanent', 'Permanent/Pensionable'],
  ['contract', 'Contract'],
  ['temporary', 'Temporary'],
  ['casual', 'Casual'],
  ['part_time', 'Part-time'],
  ['adjunct', 'Adjunct'],
  ['visiting', 'Visiting'],
  ['sabbatical', 'Sabbatical'],
  ['secondment', 'Secondment'],
  ['postdoctoral', 'Postdoctoral'],
  ['nysc', 'NYSC'],
  ['outsourced', 'Outsourced'],
]);

const EMPLOYMENT_STATUSES = named([
  ['active', 'Active'],
  ['on_probation', 'On Probation'],
  ['confirmed', 'Confirmed'],
  ['on_leave', 'On Leave'],
  ['on_study_leave', 'On Study Leave'],
  ['on_sabbatical', 'On Sabbatical'],
  ['on_secondment', 'On Secondment'],
  ['on_suspension', 'On Suspension'],
  ['on_maternity_paternity_leave', 'On Maternity/Paternity Leave'],
  ['on_medical_leave', 'On Medical Leave'],
  ['on_retirement', 'On Retirement'],
  ['retired', 'Retired'],
  ['resigned', 'Resigned'],
  ['terminated', 'Terminated'],
  ['deceased', 'Deceased'],
]);

const ranks = (pairs: readonly (readonly [string, string, ...string[]])[]): ProfileRank[] =>
  pairs.map(([key, name, ...alsoTitled]) => (alsoTitled.length > 0 ? { key, name, alsoTitled } : { key, name }));

/** Polytechnics' ladder; colleges of education use it too (with a dual-mandate college's other titles). */
const NON_UNIVERSITY_LECTURER_RANKS: readonly (readonly [string, string, ...string[]])[] = [
  ['assistant_lecturer', 'Assistant Lecturer'],
  ['lecturer_iii', 'Lecturer III'],
  ['lecturer_ii', 'Lecturer II'],
  ['lecturer_i', 'Lecturer I'],
  ['senior_lecturer', 'Senior Lecturer'],
  ['principal_lecturer', 'Principal Lecturer'],
  ['chief_lecturer', 'Chief Lecturer'],
];

/** The documents' illustrative ladder. Registrar is an office, not a rank. */
const ADMINISTRATIVE_CADRE: ProfileCadre = {
  key: 'administrative_officer',
  name: 'Administrative Officer',
  category: 'administrative',
  ranks: ranks([
    ['clerical_officer', 'Clerical Officer'],
    ['senior_clerical_officer', 'Senior Clerical Officer'],
    ['assistant_executive_officer', 'Assistant Executive Officer'],
    ['executive_officer', 'Executive Officer'],
    ['higher_executive_officer', 'Higher Executive Officer'],
    ['administrative_officer_ii', 'Administrative Officer II'],
    ['administrative_officer_i', 'Administrative Officer I'],
    ['principal_administrative_officer', 'Principal Administrative Officer'],
    ['assistant_registrar', 'Assistant Registrar'],
    ['principal_assistant_registrar', 'Principal Assistant Registrar'],
    ['senior_assistant_registrar', 'Senior Assistant Registrar'],
    ['deputy_registrar', 'Deputy Registrar'],
  ]),
  verify: true,
};

const SECRETARIAL_CADRE: ProfileCadre = {
  key: 'secretarial',
  name: 'Secretarial',
  category: 'secretarial',
  ranks: ranks([
    ['confidential_secretary_iii', 'Confidential Secretary III'],
    ['confidential_secretary_ii', 'Confidential Secretary II'],
    ['confidential_secretary_i', 'Confidential Secretary I'],
    ['senior_confidential_secretary', 'Senior Confidential Secretary'],
    ['principal_confidential_secretary', 'Principal Confidential Secretary'],
    ['chief_confidential_secretary', 'Chief Confidential Secretary'],
  ]),
  verify: true,
};

/** Named without ranks: each institution adds its ladder (S3). */
const OTHER_CADRES: readonly ProfileCadre[] = (
  [
    ['research_officer', 'Research Officer', 'research'],
    ['librarian', 'Librarian', 'library'],
    ['library_officer', 'Library Officer', 'library'],
    ['accountant', 'Accountant', 'finance'],
    ['auditor', 'Auditor', 'finance'],
    ['technologist', 'Technologist', 'technical'],
    ['technician', 'Technician', 'technical'],
    ['engineer', 'Engineer', 'professional'],
    ['ict_professional', 'ICT Professional', 'ict'],
    ['legal_officer', 'Legal Officer', 'professional'],
    ['procurement_officer', 'Procurement Officer', 'administrative'],
    ['medical_officer', 'Medical Officer', 'medical'],
    ['nursing', 'Nursing', 'medical'],
  ] as const
).map(([key, name, category]) => ({ key, name, category, ranks: [] }));

const staff = (lecturer: ProfileCadre): InstitutionProfile['staff'] => ({
  categories: STAFF_CATEGORIES,
  cadres: [lecturer, ADMINISTRATIVE_CADRE, SECRETARIAL_CADRE, ...OTHER_CADRES],
  employmentTypes: EMPLOYMENT_TYPES,
  employmentStatuses: EMPLOYMENT_STATUSES,
});

/** The unit types and their hierarchy rules (spec 0041's appendix); each type keeps the rows it has, with its names. */
const UNIT_TYPE_RULES: readonly { key: string; kind: UnitKind; mayContain: readonly string[] }[] = [
  { key: 'college', kind: 'academic', mayContain: ['faculty', 'school', 'institute', 'centre', 'department', 'academic_unit'] },
  { key: 'faculty', kind: 'academic', mayContain: ['department', 'institute', 'centre', 'academic_unit', 'unit'] },
  { key: 'school', kind: 'academic', mayContain: ['department', 'institute', 'centre', 'academic_unit', 'unit'] },
  { key: 'department', kind: 'academic', mayContain: ['academic_unit', 'unit', 'section'] },
  { key: 'academic_unit', kind: 'academic', mayContain: ['section'] },
  { key: 'institute', kind: 'research', mayContain: ['department', 'centre', 'unit', 'section'] },
  { key: 'centre', kind: 'research', mayContain: ['unit', 'section'] },
  { key: 'directorate', kind: 'administrative', mayContain: ['division', 'unit', 'section'] },
  { key: 'administrative_department', kind: 'administrative', mayContain: ['division', 'unit', 'section'] },
  { key: 'division', kind: 'administrative', mayContain: ['unit', 'section'] },
  { key: 'unit', kind: 'administrative', mayContain: ['section'] },
  { key: 'section', kind: 'administrative', mayContain: [] },
];

const COMMON_UNIT_NAMES: Readonly<Record<string, string>> = {
  school: 'School',
  department: 'Department',
  academic_unit: 'Academic Unit',
  centre: 'Centre',
  directorate: 'Directorate',
  administrative_department: 'Administrative Department',
  division: 'Division',
  unit: 'Unit',
  section: 'Section',
};

/** The rows a type has, by its names; a "may contain" never names a type the profile doesn't have. */
function unitTypes(names: Readonly<Record<string, string>>): ProfileUnitType[] {
  return UNIT_TYPE_RULES.filter((r) => Object.hasOwn(names, r.key)).map((r) => ({
    key: r.key,
    name: names[r.key] ?? r.key,
    kind: r.kind,
    mayContain: r.mayContain.filter((k) => Object.hasOwn(names, k)),
  }));
}

const levels = (prefix: string, from: number, to: number, suffix = ''): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i)}${suffix}`);
const HUNDRED_LEVELS = (n: number): string[] => Array.from({ length: n }, (_, i) => `${String((i + 1) * 100)} Level`);
const YEARS = (n: number): string[] => levels('Year ', 1, n);

const semesterAndSpecial = (special: readonly (readonly [string, string])[]): Named[] => named([['semester', 'Semester'], ...special]);

const COMMON_WINDOWS: readonly ProfileWindowType[] = named([
  ['application', 'Application'],
  ['course_registration', 'Course Registration'],
  ['late_registration', 'Late Registration'],
  ['add_drop', 'Add/Drop'],
  ['fee_payment', 'Fee Payment'],
  ['score_entry', 'Score Entry'],
  ['examination', 'Examination'],
  ['hostel_application', 'Hostel Application'],
  ['clearance', 'Clearance'],
  ['graduation_processing', 'Graduation Processing'],
  ['project_submission', 'Project Submission'],
]);

const REGULATOR_NAMES: Readonly<Record<RegulatorKey, string>> = {
  nuc: 'National Universities Commission',
  nbte: 'National Board for Technical Education',
  ncce: 'National Commission for Colleges of Education',
};
const regulators = (...keys: RegulatorKey[]) => keys.map((key) => ({ key, name: REGULATOR_NAMES[key] }));

const SEMESTERS = ['First Semester', 'Second Semester'];

/** Offices every type has, with its own names for the head, the deputy and the librarian. */
function offices(head: string, deputy: string, librarian: string, extra: { before?: ProfileOffice[]; afterHod?: ProfileOffice[]; last?: ProfileOffice[] }): ProfileOffice[] {
  return [
    { key: 'institution_head', name: head, scope: 'institution' },
    { key: 'deputy_institution_head', name: deputy, scope: 'institution' },
    { key: 'registrar', name: 'Registrar', scope: 'institution' },
    { key: 'bursar', name: 'Bursar', scope: 'institution' },
    { key: 'librarian', name: librarian, scope: 'institution' },
    ...(extra.before ?? []),
    { key: 'dean', name: 'Dean', scope: 'unit' },
    { key: 'deputy_dean', name: 'Deputy Dean', scope: 'unit' },
    { key: 'department_head', name: 'Head of Department', scope: 'unit' },
    ...(extra.afterHod ?? []),
    { key: 'director', name: 'Director', scope: 'unit' },
    { key: 'examination_officer', name: 'Examination Officer', scope: 'unit' },
    { key: 'programme_coordinator', name: 'Programme Coordinator', scope: 'programme' },
    { key: 'level_coordinator', name: 'Level Coordinator', scope: 'programme' },
    { key: 'course_adviser', name: 'Course Adviser', scope: 'programme' },
    { key: 'siwes_coordinator', name: 'SIWES Coordinator', scope: 'unit' },
    ...(extra.last ?? []),
  ];
}

const body = (key: string, name: string, kind: BodyKind, fn: BodyFunction | null, scope: 'institution' | 'unit' = 'institution'): ProfileBody => ({
  key,
  name,
  kind,
  function: fn,
  scope,
  verify: true,
});

const HOD_DEAN: readonly ApprovalStage[] = [
  { holder: { office: 'department_head' }, requirement: 'mandatory' },
  { holder: { office: 'dean' }, requirement: 'mandatory' },
];

// ── The three profiles

const UNIVERSITY: InstitutionProfile = {
  unitTypes: unitTypes({ ...COMMON_UNIT_NAMES, college: 'College', faculty: 'Faculty', institute: 'Institute' }),
  qualifications: [
    ...(
      [
        ['bsc', 'B.Sc.', 'Bachelor of Science'],
        ['ba', 'B.A.', 'Bachelor of Arts'],
        ['beng', 'B.Eng.', 'Bachelor of Engineering'],
        ['btech', 'B.Tech.', 'Bachelor of Technology'],
        ['llb', 'LL.B.', 'Bachelor of Laws'],
        ['mbbs', 'MBBS', 'Bachelor of Medicine, Bachelor of Surgery'],
      ] as const
    ).map(([key, abbreviation, name]) => ({ key, abbreviation, name, family: 'bachelor' as const, award: 'degree' as const, levels: HUNDRED_LEVELS(6), regulators: ['nuc' as const], offered: true })),
    { key: 'pgd', abbreviation: 'PGD', name: 'Postgraduate Diploma', family: 'postgraduate_diploma', award: 'diploma', levels: YEARS(1), regulators: ['nuc'], offered: true },
    ...(
      [
        ['msc', 'M.Sc.', 'Master of Science'],
        ['ma', 'M.A.', 'Master of Arts'],
        ['mba', 'MBA', 'Master of Business Administration'],
        ['mphil', 'M.Phil.', 'Master of Philosophy'],
      ] as const
    ).map(([key, abbreviation, name]) => ({ key, abbreviation, name, family: 'master' as const, award: 'degree' as const, levels: YEARS(3), regulators: ['nuc' as const], offered: true })),
    { key: 'phd', abbreviation: 'Ph.D.', name: 'Doctor of Philosophy', family: 'doctorate', award: 'degree', levels: YEARS(5), regulators: ['nuc'], offered: true },
    { key: 'diploma', abbreviation: 'Dip.', name: 'Diploma', family: 'diploma', award: 'diploma', levels: YEARS(2), regulators: ['nuc'], offered: false },
    { key: 'certificate', abbreviation: 'Cert.', name: 'Certificate', family: 'certificate', award: 'certificate', levels: YEARS(1), regulators: ['nuc'], offered: false },
  ],
  academicStructure: { semesters: SEMESTERS },
  staff: staff({
    key: 'lecturer',
    name: 'Lecturer',
    category: 'academic',
    ranks: ranks([
      ['graduate_assistant', 'Graduate Assistant'],
      ['assistant_lecturer', 'Assistant Lecturer'],
      ['lecturer_ii', 'Lecturer II'],
      ['lecturer_i', 'Lecturer I'],
      ['senior_lecturer', 'Senior Lecturer'],
      ['associate_professor', 'Associate Professor', 'Reader'],
      ['professor', 'Professor'],
    ]),
    verify: true,
  }),
  offices: offices('Vice-Chancellor', 'Deputy Vice-Chancellor', 'University Librarian', {
    before: [{ key: 'college_provost', name: 'Provost', scope: 'unit' }],
    afterHod: [{ key: 'deputy_department_head', name: 'Deputy Head of Department', scope: 'unit' }],
  }),
  governanceBodies: [
    body('governing_council', 'Governing Council', 'administrative', 'governing_body'),
    body('senate', 'Senate', 'academic', 'academic_governing_body'),
    body('management_committee', 'University Management Committee', 'administrative', 'executive_management'),
    body('unit_board', 'Faculty Board', 'academic', 'unit_academic_board', 'unit'),
    body('congregation', 'Congregation', 'assembly', null),
    body('convocation', 'Convocation', 'assembly', null),
  ],
  approvalChains: {
    curriculum: [...HOD_DEAN, { holder: { function: 'academic_governing_body' }, requirement: 'conditional', condition: 'institution_enables' }],
  },
  periodTypes: semesterAndSpecial([
    ['summer', 'Summer'],
    ['siwes', 'SIWES'],
  ]),
  windowTypes: COMMON_WINDOWS,
  regulators: regulators('nuc'),
};

const POLYTECHNIC: InstitutionProfile = {
  unitTypes: unitTypes({ ...COMMON_UNIT_NAMES, faculty: 'Faculty' }),
  qualifications: [
    { key: 'nd', abbreviation: 'ND', name: 'National Diploma', family: 'nd', award: 'diploma', levels: levels('ND', 1, 2), regulators: ['nbte'], offered: true },
    { key: 'hnd', abbreviation: 'HND', name: 'Higher National Diploma', family: 'hnd', award: 'diploma', levels: levels('HND', 1, 2), regulators: ['nbte'], offered: true },
    { key: 'nid', abbreviation: 'NID', name: 'National Innovation Diploma', family: 'nid', award: 'diploma', levels: levels('NID', 1, 2), regulators: ['nbte'], offered: false, verify: true },
    { key: 'certificate', abbreviation: 'Cert.', name: 'Certificate', family: 'certificate', award: 'certificate', levels: YEARS(1), regulators: ['nbte'], offered: false },
    { key: 'professional_diploma', abbreviation: 'Prof. Dip.', name: 'Professional Diploma', family: 'professional_diploma', award: 'diploma', levels: YEARS(1), regulators: ['nbte'], offered: false },
  ],
  academicStructure: { semesters: SEMESTERS },
  staff: staff({ key: 'lecturer', name: 'Lecturer', category: 'academic', ranks: ranks(NON_UNIVERSITY_LECTURER_RANKS), verify: true }),
  offices: offices('Rector', 'Deputy Rector', 'Polytechnic Librarian', {}),
  governanceBodies: [
    body('governing_council', 'Governing Council', 'administrative', 'governing_body'),
    body('academic_board', 'Academic Board', 'academic', 'academic_governing_body'),
    body('management_committee', 'Management Committee', 'administrative', 'executive_management'),
    body('unit_board', 'School Board', 'academic', 'unit_academic_board', 'unit'),
  ],
  approvalChains: { curriculum: [...HOD_DEAN, { holder: { function: 'academic_governing_body' }, requirement: 'mandatory' }] },
  periodTypes: semesterAndSpecial([
    ['siwes', 'SIWES'],
    ['industrial_attachment', 'Industrial Attachment'],
  ]),
  windowTypes: [
    ...COMMON_WINDOWS,
    { key: 'siwes_application', name: 'SIWES Application', needsPeriod: 'siwes' },
    { key: 'siwes_assessment', name: 'SIWES Assessment', needsPeriod: 'siwes' },
  ],
  regulators: regulators('nbte'),
};

const COLLEGE_OF_EDUCATION: InstitutionProfile = {
  unitTypes: unitTypes(COMMON_UNIT_NAMES),
  qualifications: [
    { key: 'nce', abbreviation: 'NCE', name: 'Nigeria Certificate in Education', family: 'nce', award: 'certificate', levels: levels('NCE ', 1, 3, '00 Level'), regulators: ['ncce'], offered: true },
    // The dual mandate: degrees beside the NCE, off until the institution confirms its NCCE and NUC approvals (Q9).
    ...(
      [
        ['bed', 'B.Ed.', 'Bachelor of Education'],
        ['ba_ed', 'B.A.(Ed.)', 'Bachelor of Arts (Education)'],
        ['bsc_ed', 'B.Sc.(Ed.)', 'Bachelor of Science (Education)'],
      ] as const
    ).map(([key, abbreviation, name]) => ({
      key,
      abbreviation,
      name,
      family: 'bachelor' as const,
      award: 'degree' as const,
      levels: HUNDRED_LEVELS(4),
      regulators: ['ncce' as const, 'nuc' as const],
      offered: false,
    })),
    { key: 'pgde', abbreviation: 'PGDE', name: 'Postgraduate Diploma in Education', family: 'pgde', award: 'diploma', levels: YEARS(1), regulators: ['ncce'], offered: false },
    { key: 'nsq', abbreviation: 'NSQ', name: 'National Skills Qualification', family: 'nsq', award: 'certificate', levels: YEARS(1), regulators: ['ncce'], offered: false, verify: true },
  ],
  academicStructure: { semesters: SEMESTERS },
  staff: staff({
    key: 'lecturer',
    name: 'Lecturer',
    category: 'academic',
    ranks: ranks(
      NON_UNIVERSITY_LECTURER_RANKS.map((r) =>
        r[0] === 'principal_lecturer' ? [r[0], r[1], 'Associate Professor'] : r[0] === 'chief_lecturer' ? [r[0], r[1], 'Professor'] : r,
      ),
    ),
    verify: true,
  }),
  offices: offices('Provost', 'Deputy Provost', 'College Librarian', {
    last: [{ key: 'teaching_practice_coordinator', name: 'Teaching Practice Coordinator', scope: 'unit' }],
  }),
  governanceBodies: [
    body('governing_council', 'Governing Council', 'administrative', 'governing_body'),
    body('academic_board', 'Academic Board', 'academic', 'academic_governing_body'),
    body('management_committee', 'College Management Committee', 'administrative', 'executive_management'),
    body('unit_board', 'School Board', 'academic', 'unit_academic_board', 'unit'),
    body('congregation', 'Congregation', 'assembly', null),
    body('convocation', 'Convocation', 'assembly', null),
    body('academic_staff_congregation', 'Academic Staff Congregation', 'assembly', null),
  ],
  approvalChains: { curriculum: [...HOD_DEAN, { holder: { function: 'academic_governing_body' }, requirement: 'mandatory' }] },
  periodTypes: semesterAndSpecial([
    ['teaching_practice', 'Teaching Practice'],
    ['siwes', 'SIWES'],
  ]),
  windowTypes: COMMON_WINDOWS,
  regulators: regulators('ncce', 'nuc'),
};

export const PROFILES = deepFreeze({ university: UNIVERSITY, polytechnic: POLYTECHNIC, 'college-of-education': COLLEGE_OF_EDUCATION });

// ── The checks (Q11): run before anything is copied, and by the tests

/** A problem's code and where: `unit_types.duplicate:faculty`. Never a value from outside the profile. */
export type ProfileProblem = string;

function duplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) (seen.has(k) ? dup : seen).add(k);
  return [...dup];
}

const KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Every problem with a profile, or none. */
export function profileProblems(p: InstitutionProfile): ProfileProblem[] {
  const out: string[] = [];
  const list = (name: string, items: readonly Named[], required = true) => {
    if (required && items.length === 0) out.push(`${name}.empty`);
    for (const d of duplicates(items.map((i) => i.key))) out.push(`${name}.duplicate:${d}`);
    for (const i of items) {
      if (!KEY.test(i.key)) out.push(`${name}.key_format:${i.key}`);
      if (i.name.trim() === '') out.push(`${name}.no_name:${i.key}`);
    }
  };
  list('unit_types', p.unitTypes);
  list('qualifications', p.qualifications);
  list('staff.categories', p.staff.categories);
  list('staff.cadres', p.staff.cadres);
  list('staff.employment_types', p.staff.employmentTypes);
  list('staff.employment_statuses', p.staff.employmentStatuses);
  list('offices', p.offices);
  list('governance_bodies', p.governanceBodies);
  list('period_types', p.periodTypes);
  list('window_types', p.windowTypes);
  list('regulators', p.regulators);

  // Unit types: every hierarchy rule names a unit type in the profile, never itself.
  const unitKeys = new Set(p.unitTypes.map((u) => u.key));
  for (const u of p.unitTypes) {
    for (const d of duplicates(u.mayContain)) out.push(`unit_types.may_contain_duplicate:${u.key}:${d}`);
    for (const c of u.mayContain) {
      if (!unitKeys.has(c)) out.push(`unit_types.may_contain_unknown:${u.key}:${c}`);
      if (c === u.key) out.push(`unit_types.may_contain_itself:${u.key}`);
    }
  }
  if (!p.unitTypes.some((u) => u.kind === 'academic')) out.push('unit_types.no_academic');

  // Qualifications: family, award, levels, and regulators the profile has; something offered.
  const regulatorKeys = new Set<string>(p.regulators.map((r) => r.key));
  for (const q of p.qualifications) {
    if (q.levels.length === 0) out.push(`qualifications.no_levels:${q.key}`);
    for (const d of duplicates(q.levels)) out.push(`qualifications.level_duplicate:${q.key}:${d}`);
    if (q.abbreviation.trim() === '') out.push(`qualifications.no_abbreviation:${q.key}`);
    if (q.regulators.length === 0) out.push(`qualifications.no_regulator:${q.key}`);
    for (const r of q.regulators) if (!regulatorKeys.has(r)) out.push(`qualifications.regulator_unknown:${q.key}:${r}`);
  }
  if (!p.qualifications.some((q) => q.offered)) out.push('qualifications.none_offered');
  for (const r of p.regulators) if (!p.qualifications.some((q) => q.regulators.includes(r.key))) out.push(`regulators.regulates_nothing:${r.key}`);

  // The academic structure.
  if (p.academicStructure.semesters.length === 0) out.push('academic_structure.no_semesters');
  for (const d of duplicates(p.academicStructure.semesters)) out.push(`academic_structure.semester_duplicate:${d}`);

  // Staff: every cadre names a category; ranks unique within a cadre; an academic cadre with ranks.
  const categories = new Set(p.staff.categories.map((c) => c.key));
  for (const c of p.staff.cadres) {
    if (!categories.has(c.category)) out.push(`staff.cadre_category_unknown:${c.key}:${c.category}`);
    for (const d of duplicates(c.ranks.map((r) => r.key))) out.push(`staff.rank_duplicate:${c.key}:${d}`);
  }
  if (!p.staff.cadres.some((c) => c.category === 'academic' && c.ranks.length > 0)) out.push('staff.no_academic_ladder');

  // Governance: academic and administrative governance apart; Senate and Academic Board never both; one academic
  // governing body; an assembly holds no function.
  const bodyKeys = new Set(p.governanceBodies.map((b) => b.key));
  if (bodyKeys.has('senate') && bodyKeys.has('academic_board')) out.push('governance_bodies.senate_and_academic_board');
  const holders = new Map<BodyFunction, ProfileBody[]>();
  for (const b of p.governanceBodies) {
    if (b.kind === 'assembly' && b.function !== null) out.push(`governance_bodies.assembly_with_function:${b.key}`);
    if (b.function === null) continue;
    holders.set(b.function, [...(holders.get(b.function) ?? []), b]);
  }
  for (const [fn, bs] of holders) if (bs.length > 1) out.push(`governance_bodies.function_held_twice:${fn}`);
  const academicGoverning = holders.get('academic_governing_body') ?? [];
  if (academicGoverning.length !== 1) out.push('governance_bodies.no_academic_governing_body');
  for (const b of academicGoverning) if (b.kind !== 'academic') out.push(`governance_bodies.academic_function_not_academic:${b.key}`);
  for (const fn of ['governing_body', 'executive_management'] as const) for (const b of holders.get(fn) ?? []) if (b.kind !== 'administrative') out.push(`governance_bodies.administrative_function_not_administrative:${b.key}`);

  // Approval chains: every stage resolves; at least one mandatory; none twice; a conditional stage names its condition.
  const officeKeys = new Set(p.offices.map((o) => o.key));
  for (const [chain, stages] of Object.entries<readonly ApprovalStage[]>(p.approvalChains)) {
    if (!stages.some((s) => s.requirement === 'mandatory')) out.push(`approval_chains.no_mandatory_stage:${chain}`);
    const seen: string[] = [];
    for (const s of stages) {
      const id = 'office' in s.holder ? `office:${s.holder.office}` : `function:${s.holder.function}`;
      seen.push(id);
      if ('office' in s.holder && !officeKeys.has(s.holder.office)) out.push(`approval_chains.office_unknown:${chain}:${s.holder.office}`);
      if ('function' in s.holder) {
        const fn = s.holder.function;
        const held = holders.get(fn) ?? [];
        if (held.length === 0) out.push(`approval_chains.function_unheld:${chain}:${fn}`);
        if (held.some((b) => b.kind === 'assembly')) out.push(`approval_chains.assembly_stage:${chain}:${fn}`);
      }
      if (s.requirement === 'conditional' && s.condition === undefined) out.push(`approval_chains.condition_missing:${chain}`);
      if (s.requirement === 'mandatory' && s.condition !== undefined) out.push(`approval_chains.condition_on_mandatory:${chain}`);
    }
    for (const d of duplicates(seen)) out.push(`approval_chains.stage_twice:${chain}:${d}`);
  }

  // Periods and windows: a semester; a window that needs a special period only where the profile has it.
  const periodKeys = new Set(p.periodTypes.map((x) => x.key));
  if (!periodKeys.has('semester')) out.push('period_types.no_semester');
  for (const w of p.windowTypes) if (w.needsPeriod !== undefined && !periodKeys.has(w.needsPeriod)) out.push(`window_types.period_missing:${w.key}:${w.needsPeriod}`);

  return out;
}

// ── The content hash (Q6, Q11)
//
// The profile's content hash is SHA-256 over `canonicalJson(profile)` (approvals.ts, spec 0037 Q3), computed where
// `node:crypto` is (packages/db's `profileHash`). The snapshot and the platform's assignment both hold it.
