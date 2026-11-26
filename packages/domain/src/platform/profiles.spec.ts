import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './approvals.js';
import { PROFILES, profileProblems, type InstitutionProfile } from './profiles.js';
import { TEMPLATE_IDS, TEMPLATES, templateForType } from './provisioning.js';
import type { TenantTypeName } from './tenant-registry.js';

/** A mutable deep copy, to break one thing at a time. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
const copy = (p: InstitutionProfile): Mutable<InstitutionProfile> => structuredClone(p) as Mutable<InstitutionProfile>;
const problems = (p: Mutable<InstitutionProfile>) => profileProblems(p);
const sha256 = (p: InstitutionProfile) => createHash('sha256').update(canonicalJson(p)).digest('hex');

const keys = (items: readonly { key: string }[]) => items.map((i) => i.key);

describe('the three profiles (spec 0041 Q11)', () => {
  it.each(TEMPLATE_IDS)('%s passes every check', (id) => {
    expect(profileProblems(PROFILES[id])).toEqual([]);
  });

  it.each(TEMPLATE_IDS)('%s loads on its own: plain JSON, round-trips', (id) => {
    const p = PROFILES[id];
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    expect(JSON.parse(canonicalJson(p))).toEqual(p);
  });

  it('one template per supported institution type, each at version 2 with its profile (Q1)', () => {
    const types: TenantTypeName[] = ['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION'];
    expect(types.map(templateForType)).toEqual(['university', 'polytechnic', 'college-of-education']);
    expect(new Set(TEMPLATE_IDS.map((id) => TEMPLATES[id].forType))).toEqual(new Set(types));
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATES[id].version).toBe(2);
      expect(TEMPLATES[id].profile).toBe(PROFILES[id]);
    }
  });

  it('version integrity: each version’s content is pinned by its hash, so a change needs a new version (Q11)', () => {
    expect(Object.fromEntries(TEMPLATE_IDS.map((id) => [`${id}@${String(TEMPLATES[id].version)}`, sha256(PROFILES[id])]))).toEqual({
      'university@2': '52a77041d0002aabc96bb88ebcd4f94762abe406a61e4ff387cfd81fa08d2170',
      'polytechnic@2': 'b561011e91c5ae9f643764027d6c7b99e65d51ce08e1ced1467ec90eb0fe0b29',
      'college-of-education@2': '6ba7744e0c78722291e99dedc3b104f3e7e6c9da08418ec789753f32b2cbe0f8',
    });
  });

  it('is frozen all the way down', () => {
    const frozen = (v: unknown): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(frozen(PROFILES)).toBe(true);
    expect(() => {
      (PROFILES.university.unitTypes as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe('the differences the guidance documents require (the appendix)', () => {
  const { university: u, polytechnic: p, 'college-of-education': c } = PROFILES;
  const office = (pr: InstitutionProfile, key: string) => pr.offices.find((o) => o.key === key)?.name;
  const lecturer = (pr: InstitutionProfile) => pr.staff.cadres.find((x) => x.key === 'lecturer')?.ranks ?? [];

  it('keys are shared and the names are each type’s own (Q3)', () => {
    expect([office(u, 'institution_head'), office(p, 'institution_head'), office(c, 'institution_head')]).toEqual(['Vice-Chancellor', 'Rector', 'Provost']);
    expect([office(u, 'department_head'), office(p, 'department_head'), office(c, 'department_head')]).toEqual(['Head of Department', 'Head of Department', 'Head of Department']);
    expect(u.unitTypes.find((t) => t.key === 'faculty')?.name).toBe('Faculty');
    expect(keys(c.unitTypes)).not.toContain('faculty');
  });

  it('Senate and Academic Board are distinct bodies holding the same function (Q3)', () => {
    const holder = (pr: InstitutionProfile) => pr.governanceBodies.find((b) => b.function === 'academic_governing_body');
    expect([holder(u)?.key, holder(p)?.key, holder(c)?.key]).toEqual(['senate', 'academic_board', 'academic_board']);
    expect(keys(u.governanceBodies)).not.toContain('academic_board');
    expect(keys(p.governanceBodies)).not.toContain('senate');
    expect(p.governanceBodies.find((b) => b.key === 'unit_board')?.name).toBe('School Board');
    expect(u.governanceBodies.find((b) => b.key === 'unit_board')?.name).toBe('Faculty Board');
  });

  it('the curriculum chains: the university’s Senate stage is conditional; the others’ Academic Board is mandatory (spec 0040 Q5)', () => {
    const last = (pr: InstitutionProfile) => pr.approvalChains.curriculum.at(-1);
    expect(last(u)).toEqual({ holder: { function: 'academic_governing_body' }, requirement: 'conditional', condition: 'institution_enables' });
    expect(last(p)).toEqual({ holder: { function: 'academic_governing_body' }, requirement: 'mandatory' });
    expect(last(c)).toEqual(last(p));
    for (const pr of [u, p, c]) expect(pr.approvalChains.curriculum.slice(0, 2).map((s) => s.holder)).toEqual([{ office: 'department_head' }, { office: 'dean' }]);
  });

  it('qualifications are offered only where the type normally awards them, and degrees are never assumed approved (Q9)', () => {
    const offered = (pr: InstitutionProfile) => pr.qualifications.filter((q) => q.offered).map((q) => q.family);
    expect(new Set(offered(u))).toEqual(new Set(['bachelor', 'postgraduate_diploma', 'master', 'doctorate']));
    expect(u.qualifications.filter((q) => !q.offered).map((q) => q.family)).toEqual(['diploma', 'certificate']);
    expect(offered(p)).toEqual(['nd', 'hnd']);
    expect(p.qualifications.find((q) => q.key === 'nid')?.offered).toBe(false);
    expect(offered(c)).toEqual(['nce']);
    const degrees = c.qualifications.filter((q) => q.family === 'bachelor');
    expect(keys(degrees)).toEqual(['bed', 'ba_ed', 'bsc_ed']);
    for (const d of degrees) {
      expect(d.offered).toBe(false);
      expect(d.regulators).toEqual(['ncce', 'nuc']);
    }
  });

  it('level labels are each qualification’s own', () => {
    expect(p.qualifications.find((q) => q.key === 'nd')?.levels).toEqual(['ND1', 'ND2']);
    expect(p.qualifications.find((q) => q.key === 'hnd')?.levels).toEqual(['HND1', 'HND2']);
    expect(c.qualifications.find((q) => q.key === 'nce')?.levels).toEqual(['NCE 100 Level', 'NCE 200 Level', 'NCE 300 Level']);
    expect(u.qualifications.find((q) => q.key === 'bsc')?.levels).toEqual(['100 Level', '200 Level', '300 Level', '400 Level', '500 Level', '600 Level']);
  });

  it('the academic ladders: professors at a university, chief lecturers elsewhere; a dual-mandate college’s other titles', () => {
    expect(lecturer(u).map((r) => r.key)).toEqual(['graduate_assistant', 'assistant_lecturer', 'lecturer_ii', 'lecturer_i', 'senior_lecturer', 'associate_professor', 'professor']);
    expect(lecturer(u).find((r) => r.key === 'associate_professor')?.alsoTitled).toEqual(['Reader']);
    expect(lecturer(p).at(-1)?.name).toBe('Chief Lecturer');
    expect(lecturer(c).map((r) => r.key)).toEqual(lecturer(p).map((r) => r.key));
    expect(lecturer(c).find((r) => r.key === 'principal_lecturer')?.alsoTitled).toEqual(['Associate Professor']);
    expect(lecturer(c).find((r) => r.key === 'chief_lecturer')?.alsoTitled).toEqual(['Professor']);
    expect(lecturer(p).some((r) => r.alsoTitled !== undefined)).toBe(false);
  });

  it('periods and windows: SIWES windows only at the polytechnic; Teaching Practice at the college', () => {
    expect(keys(p.windowTypes)).toEqual(expect.arrayContaining(['siwes_application', 'siwes_assessment']));
    expect(keys(u.windowTypes)).not.toContain('siwes_application');
    expect(keys(c.periodTypes)).toContain('teaching_practice');
    expect(keys(u.periodTypes)).toContain('summer');
    expect(keys(c.offices)).toContain('teaching_practice_coordinator');
    expect(keys(u.offices)).not.toContain('teaching_practice_coordinator');
  });

  it('regulators: NUC, NBTE, and NCCE with NUC for the dual mandate', () => {
    expect([u, p, c].map((pr) => keys(pr.regulators))).toEqual([['nuc'], ['nbte'], ['ncce', 'nuc']]);
  });

  it('Graduate Assistant is a rank, never also an employment type', () => {
    for (const pr of [u, p, c]) expect(keys(pr.staff.employmentTypes)).not.toContain('graduate_assistant');
  });
});

describe('profileProblems finds each kind of fault (Q11)', () => {
  const base = () => copy(PROFILES.polytechnic);

  it('required lists, unique keys, key format and names', () => {
    const p = base();
    p.offices = [];
    expect(problems(p)).toContain('offices.empty');
    const q = base();
    q.windowTypes.push({ ...q.windowTypes[0]! });
    expect(problems(q)).toContain('window_types.duplicate:application');
    const r = base();
    r.unitTypes[0]!.key = 'School';
    expect(problems(r)).toContain('unit_types.key_format:School');
    const s = base();
    s.periodTypes[0]!.name = '  ';
    expect(problems(s)).toContain('period_types.no_name:semester');
  });

  it('hierarchy rules: unknown, repeated and self references; an academic type', () => {
    const p = base();
    p.unitTypes.find((u) => u.key === 'department')!.mayContain.push('college', 'department', 'section');
    expect(problems(p)).toEqual(
      expect.arrayContaining(['unit_types.may_contain_unknown:department:college', 'unit_types.may_contain_itself:department', 'unit_types.may_contain_duplicate:department:section']),
    );
    const q = base();
    for (const u of q.unitTypes) u.kind = 'administrative';
    expect(problems(q)).toContain('unit_types.no_academic');
  });

  it('qualifications: levels, abbreviation, regulators, something offered', () => {
    const p = base();
    const nd = p.qualifications[0]!;
    nd.levels = [];
    nd.abbreviation = '';
    nd.regulators = ['nuc'];
    p.qualifications[1]!.levels = ['HND1', 'HND1'];
    p.qualifications[2]!.regulators = [];
    expect(problems(p)).toEqual(
      expect.arrayContaining([
        'qualifications.no_levels:nd',
        'qualifications.no_abbreviation:nd',
        'qualifications.regulator_unknown:nd:nuc',
        'qualifications.level_duplicate:hnd:HND1',
        'qualifications.no_regulator:nid',
      ]),
    );
    const q = base();
    for (const x of q.qualifications) x.offered = false;
    expect(problems(q)).toContain('qualifications.none_offered');
    const r = base();
    r.regulators.push({ key: 'ncce', name: 'NCCE' });
    expect(problems(r)).toContain('regulators.regulates_nothing:ncce');
  });

  it('the academic structure needs its semesters, once each', () => {
    const p = base();
    p.academicStructure.semesters = [];
    expect(problems(p)).toContain('academic_structure.no_semesters');
    const q = base();
    q.academicStructure.semesters = ['First Semester', 'First Semester'];
    expect(problems(q)).toContain('academic_structure.semester_duplicate:First Semester');
  });

  it('staff: a cadre’s category exists, its ranks are unique, and there is an academic ladder', () => {
    const p = base();
    p.staff.cadres[1]!.category = 'nowhere';
    const lecturer = p.staff.cadres[0]!;
    lecturer.ranks.push({ ...lecturer.ranks[0]! });
    expect(problems(p)).toEqual(expect.arrayContaining(['staff.cadre_category_unknown:administrative_officer:nowhere', 'staff.rank_duplicate:lecturer:assistant_lecturer']));
    const q = base();
    q.staff.cadres[0]!.ranks = [];
    expect(problems(q)).toContain('staff.no_academic_ladder');
  });

  it('governance: never Senate and Academic Board together; one academic governing body, academic; administrative functions administrative; assemblies hold none', () => {
    const p = base();
    p.governanceBodies.push({ key: 'senate', name: 'Senate', kind: 'academic', function: 'academic_governing_body', scope: 'institution', verify: true });
    expect(problems(p)).toEqual(expect.arrayContaining(['governance_bodies.senate_and_academic_board', 'governance_bodies.function_held_twice:academic_governing_body', 'governance_bodies.no_academic_governing_body']));
    const q = base();
    q.governanceBodies.find((b) => b.key === 'academic_board')!.kind = 'administrative';
    q.governanceBodies.find((b) => b.key === 'governing_council')!.kind = 'academic';
    expect(problems(q)).toEqual(
      expect.arrayContaining(['governance_bodies.academic_function_not_academic:academic_board', 'governance_bodies.administrative_function_not_administrative:governing_council']),
    );
    const r = base();
    r.governanceBodies.push({ key: 'congregation', name: 'Congregation', kind: 'assembly', function: 'executive_management', scope: 'institution', verify: true });
    expect(problems(r)).toEqual(expect.arrayContaining(['governance_bodies.assembly_with_function:congregation']));
    const s = base();
    s.governanceBodies = s.governanceBodies.filter((b) => b.key !== 'academic_board');
    expect(problems(s)).toEqual(expect.arrayContaining(['governance_bodies.no_academic_governing_body', 'approval_chains.function_unheld:curriculum:academic_governing_body']));
  });

  it('approval chains: stages resolve, one is mandatory, none twice, conditions only where conditional', () => {
    const p = base();
    p.approvalChains.curriculum = [
      { holder: { office: 'provost' }, requirement: 'conditional' },
      { holder: { office: 'provost' }, requirement: 'conditional', condition: 'institution_enables' },
    ];
    expect(problems(p)).toEqual(
      expect.arrayContaining([
        'approval_chains.office_unknown:curriculum:provost',
        'approval_chains.no_mandatory_stage:curriculum',
        'approval_chains.condition_missing:curriculum',
        'approval_chains.stage_twice:curriculum:office:provost',
      ]),
    );
    const q = base();
    q.approvalChains.curriculum[0] = { holder: { office: 'department_head' }, requirement: 'mandatory', condition: 'institution_enables' };
    expect(problems(q)).toContain('approval_chains.condition_on_mandatory:curriculum');
    const r = base();
    r.governanceBodies.find((b) => b.key === 'academic_board')!.kind = 'assembly';
    expect(problems(r)).toContain('approval_chains.assembly_stage:curriculum:academic_governing_body');
  });

  it('periods and windows: a semester, and a SIWES window only beside a SIWES period', () => {
    const p = base();
    p.periodTypes = p.periodTypes.filter((x) => x.key !== 'semester' && x.key !== 'siwes');
    expect(problems(p)).toEqual(expect.arrayContaining(['period_types.no_semester', 'window_types.period_missing:siwes_application:siwes']));
  });
});
