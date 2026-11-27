import { describe, expect, it } from 'vitest';
import {
  archiveProblem,
  capacityProblem,
  childPath,
  codeProblem,
  deactivateProblem,
  depthBelowRoot,
  effectiveDateProblem,
  isCalendarDate,
  isWithin,
  lagosToday,
  legacyColumns,
  moveProblem,
  normaliseCode,
  ORG_LIMITS,
  placementProblem,
  reactivateProblem,
  retypeProblem,
  typeKeyFromName,
  type TypeRef,
  type UnitRef,
} from './tree.js';

const type = (id: string, mayContain: string[] = [], over: Partial<TypeRef> = {}): TypeRef => ({ id, kind: 'ACADEMIC', status: 'ACTIVE', mayContain, ...over });
const faculty = type('faculty', ['department']);
const department = type('department', ['section']);
const directorate = type('directorate', ['section'], { kind: 'ADMINISTRATIVE' });

const root: UnitRef = { id: 'r', parentId: null, path: '/r/', state: 'ACTIVE', typeId: null };
const sci: UnitRef = { id: 's', parentId: 'r', path: '/r/s/', state: 'ACTIVE', typeId: 'faculty' };
const csc: UnitRef = { id: 'c', parentId: 's', path: '/r/s/c/', state: 'ACTIVE', typeId: 'department' };
const eng: UnitRef = { id: 'e', parentId: 'r', path: '/r/e/', state: 'ACTIVE', typeId: 'faculty' };
const code = (p: { code: string } | null) => p?.code ?? null;

/** A path `n` levels below the root. */
const deepPath = (n: number) => `/r/${Array.from({ length: n }, (_, i) => `u${String(i)}`).join('/')}/`;

describe('paths (Q13)', () => {
  it('builds, measures and tests a path', () => {
    expect(childPath('/r/s/', 'c')).toBe('/r/s/c/');
    expect([depthBelowRoot('/r/'), depthBelowRoot('/r/s/'), depthBelowRoot('/r/s/c/')]).toEqual([0, 1, 2]);
    expect(isWithin('/r/s/c/', 's')).toBe(true);
    expect(isWithin('/r/s/c/', 'c')).toBe(true);
    expect(isWithin('/r/e/', 's')).toBe(false);
    // A prefix of an id isn't the id: the slashes are part of the match.
    expect(isWithin('/r/ss/', 's')).toBe(false);
  });
});

describe('placement (Q3)', () => {
  it('lets the root take any active type, and a type take only what it may contain', () => {
    expect(placementProblem({ parent: root, parentType: null, childType: directorate })).toBeNull();
    expect(placementProblem({ parent: sci, parentType: faculty, childType: department })).toBeNull();
    expect(code(placementProblem({ parent: sci, parentType: faculty, childType: directorate }))).toBe('org.unit.type_not_allowed');
  });

  it('refuses an archived type, and a parent that is inactive or archived', () => {
    expect(code(placementProblem({ parent: root, parentType: null, childType: type('x', [], { status: 'ARCHIVED' }) }))).toBe('org.unit.type_archived');
    expect(code(placementProblem({ parent: { ...sci, state: 'INACTIVE' }, parentType: faculty, childType: department }))).toBe('org.unit.parent_not_active');
    expect(code(placementProblem({ parent: { ...sci, state: 'ARCHIVED' }, parentType: faculty, childType: department }))).toBe('org.unit.parent_not_active');
  });

  it('stops at the depth limit, and the count limit', () => {
    const open = type('open', ['open']);
    const at = (n: number): UnitRef => ({ id: 'p', parentId: 'q', path: deepPath(n), state: 'ACTIVE', typeId: 'open' });
    expect(placementProblem({ parent: at(ORG_LIMITS.maxDepthBelowRoot - 1), parentType: open, childType: open })).toBeNull();
    expect(code(placementProblem({ parent: at(ORG_LIMITS.maxDepthBelowRoot), parentType: open, childType: open }))).toBe('org.unit.too_deep');
    expect(capacityProblem(ORG_LIMITS.maxUnits - 1)).toBeNull();
    expect(code(capacityProblem(ORG_LIMITS.maxUnits))).toBe('org.unit.limit_reached');
  });
});

describe('moves (Q3, Q11)', () => {
  const move = (over: Partial<Parameters<typeof moveProblem>[0]> = {}) =>
    code(moveProblem({ unit: csc, unitType: department, newParent: eng, newParentType: faculty, subtreeHeight: 0, ...over }));

  it('moves a department to another faculty', () => {
    expect(move()).toBeNull();
  });

  it('never moves a unit under itself or a descendant', () => {
    expect(move({ unit: sci, unitType: faculty, newParent: sci, newParentType: faculty })).toBe('org.unit.cycle');
    expect(move({ unit: sci, unitType: faculty, newParent: csc, newParentType: department })).toBe('org.unit.cycle');
  });

  it('refuses the root, an archived unit, the same parent, a closed parent and a forbidden type', () => {
    expect(move({ unit: root, unitType: null })).toBe('org.unit.root_fixed');
    expect(move({ unit: { ...csc, state: 'ARCHIVED' } })).toBe('org.unit.archived');
    expect(move({ newParent: sci })).toBe('org.unit.same_parent');
    expect(move({ newParent: { ...eng, state: 'INACTIVE' } })).toBe('org.unit.parent_not_active');
    expect(move({ newParentType: type('faculty', ['section']) })).toBe('org.unit.type_not_allowed');
  });

  it('moves an inactive unit, and the root takes any type', () => {
    expect(move({ unit: { ...csc, state: 'INACTIVE' } })).toBeNull();
    expect(move({ newParent: root, newParentType: null })).toBeNull();
  });

  it('keeps the whole subtree inside the depth limit', () => {
    const height = ORG_LIMITS.maxDepthBelowRoot - 2; // eng is at 1, csc lands at 2, its deepest at 2 + height
    expect(move({ subtreeHeight: height })).toBeNull();
    expect(move({ subtreeHeight: height + 1 })).toBe('org.unit.too_deep');
  });
});

describe('statuses (Q5)', () => {
  it('deactivates an active unit, never the root', () => {
    expect(deactivateProblem(csc)).toBeNull();
    expect(code(deactivateProblem(root))).toBe('org.unit.root_fixed');
    expect(code(deactivateProblem({ ...csc, state: 'INACTIVE' }))).toBe('org.unit.not_active');
    expect(code(deactivateProblem({ ...csc, state: 'ARCHIVED' }))).toBe('org.unit.not_active');
  });

  it('archives leaf first, with the count in the refusal', () => {
    expect(archiveProblem(csc, 0)).toBeNull();
    expect(archiveProblem({ ...csc, state: 'INACTIVE' }, 0)).toBeNull();
    expect(archiveProblem(sci, 2)).toMatchObject({ code: 'org.unit.has_open_children', details: { openChildren: 2 }, message: 'Archive its 2 units first.' });
    expect(archiveProblem(sci, 1)?.message).toBe('Archive its 1 unit first.');
    expect(code(archiveProblem(root, 0))).toBe('org.unit.root_fixed');
    expect(code(archiveProblem({ ...csc, state: 'ARCHIVED' }, 0))).toBe('org.unit.already_archived');
  });

  it('reactivates under an active parent only', () => {
    expect(reactivateProblem({ ...csc, state: 'INACTIVE' }, sci)).toBeNull();
    expect(reactivateProblem({ ...csc, state: 'ARCHIVED' }, sci)).toBeNull();
    expect(code(reactivateProblem(csc, sci))).toBe('org.unit.already_active');
    expect(code(reactivateProblem({ ...csc, state: 'ARCHIVED' }, { ...sci, state: 'ARCHIVED' }))).toBe('org.unit.parent_not_active');
    expect(code(reactivateProblem({ ...csc, state: 'ARCHIVED' }, null))).toBe('org.unit.parent_not_active');
  });
});

describe('retyping (Q10)', () => {
  const school = type('school', ['department']);
  const retype = (over: Partial<Parameters<typeof retypeProblem>[0]> = {}) =>
    code(retypeProblem({ unit: sci, currentType: faculty, newType: school, parentType: null, childTypeIds: ['department'], ...over }));

  it('changes a faculty into a school when the parent and the children fit', () => {
    expect(retype()).toBeNull();
  });

  it('refuses another kind, an archived type, the same type, a parent that refuses it and children it refuses', () => {
    expect(retype({ newType: type('school', ['department'], { kind: 'ADMINISTRATIVE' }) })).toBe('org.unit.kind_change');
    expect(retype({ newType: type('school', ['department'], { status: 'ARCHIVED' }) })).toBe('org.unit.type_archived');
    expect(retype({ newType: faculty })).toBe('org.unit.same_type');
    expect(retype({ parentType: type('college', ['faculty']) })).toBe('org.unit.type_not_allowed');
    expect(retypeProblem({ unit: sci, currentType: faculty, newType: type('school', []), parentType: null, childTypeIds: ['department', 'department', 'section'] })).toMatchObject({
      code: 'org.unit.children_not_allowed',
      details: { childTypes: 2 },
    });
    expect(retype({ unit: root, currentType: null })).toBe('org.unit.root_fixed');
  });
});

describe('codes (Q8)', () => {
  it('trims and upper-cases, and reads empty as no code yet', () => {
    expect(normaliseCode('  csc ')).toBe('CSC');
    expect(normaliseCode('   ')).toBeNull();
    expect(normaliseCode(null)).toBeNull();
    expect(normaliseCode(undefined)).toBeNull();
  });

  it('takes 2 to 12 letters and digits, starting with a letter', () => {
    for (const ok of ['CS', 'CSC', 'SICT', 'ABCDEFGHIJKL', 'C1']) expect(codeProblem(ok), ok).toBeNull();
    for (const bad of ['C', '1CS', 'CS-C', 'CS C', 'ABCDEFGHIJKLM', 'csc']) expect(code(codeProblem(bad)), bad).toBe('org.unit.code_invalid');
  });
});

describe('effective dates (Q7)', () => {
  it('reads real calendar days only', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '26-01-01', '2026-01-01T00:00:00Z', '']) expect(isCalendarDate(bad), bad).toBe(false);
  });

  it('takes today or earlier, never the future, never before the change before it', () => {
    expect(effectiveDateProblem('2026-11-26', '2026-11-26', null)).toBeNull();
    expect(effectiveDateProblem('2026-09-01', '2026-11-26', '2026-09-01')).toBeNull();
    expect(code(effectiveDateProblem('2026-11-27', '2026-11-26', null))).toBe('org.unit.effective_date_future');
    expect(effectiveDateProblem('2026-08-31', '2026-11-26', '2026-09-01')).toMatchObject({ code: 'org.unit.effective_date_out_of_order', details: { notBefore: '2026-09-01' } });
    expect(code(effectiveDateProblem('2026-02-30', '2026-11-26', null))).toBe('org.unit.effective_date_invalid');
  });

  it("knows today in Lagos: an hour ahead of UTC, all year", () => {
    expect(lagosToday(new Date('2026-11-26T22:59:59Z'))).toBe('2026-11-26');
    expect(lagosToday(new Date('2026-11-26T23:00:00Z'))).toBe('2026-11-27');
    expect(lagosToday(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });
});

describe('type keys (Q2)', () => {
  it('makes a snake_case key from a name, unique among the keys taken', () => {
    expect(typeKeyFromName('Teaching Hospital', new Set())).toBe('teaching_hospital');
    expect(typeKeyFromName('Teaching Hospital', new Set(['teaching_hospital']))).toBe('teaching_hospital_2');
    expect(typeKeyFromName('Teaching Hospital', new Set(['teaching_hospital', 'teaching_hospital_2']))).toBe('teaching_hospital_3');
    expect(typeKeyFromName('Écoles & Centres', new Set())).toBe('ecoles_centres');
    expect(typeKeyFromName('3D Studio', new Set())).toBe('type_3d_studio');
    expect(typeKeyFromName('!!!', new Set())).toBe('type');
    expect(typeKeyFromName('X', new Set())).toBe('x_type');
    for (const k of ['teaching_hospital', 'type_3d_studio', 'type', 'x_type']) expect(k).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
  });
});

describe('the old columns (Q16)', () => {
  it('writes values the earlier images can read', () => {
    expect(legacyColumns(null, null, 'ACTIVE')).toEqual({ kind: 'ACADEMIC', type: 'INSTITUTION', status: 'ACTIVE' });
    expect(legacyColumns('ACADEMIC', 'faculty', 'INACTIVE')).toEqual({ kind: 'ACADEMIC', type: 'FACULTY', status: 'ACTIVE' });
    expect(legacyColumns('RESEARCH', 'centre', 'ARCHIVED')).toEqual({ kind: 'ACADEMIC', type: 'CENTRE', status: 'ARCHIVED' });
    expect(legacyColumns('ADMINISTRATIVE', 'directorate', 'ACTIVE')).toEqual({ kind: 'ADMINISTRATIVE', type: 'UNIT', status: 'ACTIVE' });
    expect(legacyColumns('ACADEMIC', 'academic_unit', 'ACTIVE').type).toBe('UNIT');
  });
});
