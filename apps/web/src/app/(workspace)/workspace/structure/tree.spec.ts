import { describe, expect, it } from 'vitest';
import {
  allowedChildTypes,
  ancestorsOf,
  buildTree,
  moveTargets,
  searchHits,
  subtreeIds,
} from './tree';
import type { Unit, UnitType } from './words';

const type = (
  id: string,
  key: string,
  mayContain: string[],
  over: Partial<UnitType> = {},
): UnitType => ({
  id,
  key,
  name: key,
  kind: 'ACADEMIC',
  status: 'ACTIVE',
  sortOrder: 0,
  mayContain,
  units: 0,
  version: 1,
  ...over,
});
const TYPES = [
  type('tf', 'faculty', ['department']),
  type('td', 'department', ['section']),
  type('ts', 'section', []),
  type('tr', 'directorate', ['section'], { kind: 'ADMINISTRATIVE' }),
];
const unit = (
  id: string,
  parentId: string | null,
  typeId: string | null,
  name: string,
  over: Partial<Unit> = {},
): Unit => ({
  id,
  parentId,
  code: null,
  name,
  typeId,
  state: 'ACTIVE',
  followsRules: true,
  ...over,
});
const UNITS = [
  unit('r', null, null, 'Demo University'),
  unit('sci', 'r', 'tf', 'Faculty of Science', { code: 'SCI' }),
  unit('eng', 'r', 'tf', 'Faculty of Engineering', { code: 'ENG' }),
  unit('csc', 'sci', 'td', 'Computer Science', { code: 'CSC' }),
  unit('lab', 'csc', 'ts', 'Laboratory'),
  unit('reg', 'r', 'tr', 'Registry', { code: 'REG' }),
  unit('old', 'r', 'tf', 'Faculty of Ágriculture', { state: 'INACTIVE' }),
];
const tree = buildTree(UNITS);

describe('the tree from the flat list (spec 0042 Q14)', () => {
  it('groups children under their parent, and puts the root at the top', () => {
    expect(tree.tops.map((u) => u.id)).toEqual(['r']);
    expect((tree.children.get('r') ?? []).map((u) => u.id)).toEqual(['sci', 'eng', 'reg', 'old']);
    expect(ancestorsOf(tree, 'lab').map((u) => u.id)).toEqual(['r', 'sci', 'csc']);
    expect([...subtreeIds(tree, 'sci')].sort()).toEqual(['csc', 'lab', 'sci']);
  });

  it('draws a scoped caller’s parts as their own tops (their parent isn’t in the list)', () => {
    const scoped = buildTree(UNITS.filter((u) => ['sci', 'csc', 'lab'].includes(u.id)));
    expect(scoped.tops.map((u) => u.id)).toEqual(['sci']);
    expect(ancestorsOf(scoped, 'lab').map((u) => u.id)).toEqual(['sci', 'csc']);
  });
});

describe('what the page offers (the API decides again)', () => {
  it('offers the types the parent may hold; the root holds every active type', () => {
    expect(allowedChildTypes(tree.byId.get('sci')!, TYPES).map((t) => t.key)).toEqual([
      'department',
    ]);
    expect(
      allowedChildTypes(tree.byId.get('r')!, [
        ...TYPES,
        type('tx', 'gone', [], { status: 'ARCHIVED' }),
      ]).map((t) => t.key),
    ).toEqual(['faculty', 'department', 'section', 'directorate']);
  });

  it('moves a unit only under an active unit that may hold it, never under itself or where it already is', () => {
    expect(moveTargets(tree, tree.byId.get('csc')!, TYPES).map((u) => u.id)).toEqual(['r', 'eng']); // the root holds any type; not SCI (its parent), nor inactive Agriculture
    expect(moveTargets(tree, tree.byId.get('sci')!, TYPES).map((u) => u.id)).toEqual([]); // only the root holds a faculty, and it's there
    expect(
      moveTargets(tree, tree.byId.get('lab')!, TYPES)
        .map((u) => u.id)
        .sort(),
    ).toEqual(['r', 'reg']); // a directorate may hold a section
    expect(moveTargets(tree, tree.byId.get('r')!, TYPES)).toEqual([]); // the root has no type
  });
});

describe('search (Q3)', () => {
  it('finds by name or code, accents and case aside, and shows the path to each match', () => {
    const hits = searchHits(tree, 'lab');
    expect([...(hits?.matches ?? [])]).toEqual(['lab']);
    expect([...(hits?.shown ?? [])].sort()).toEqual(['csc', 'lab', 'r', 'sci']);
    expect([...(searchHits(tree, 'csc')?.matches ?? [])]).toEqual(['csc']);
    expect([...(searchHits(tree, 'agriculture')?.matches ?? [])]).toEqual(['old']);
    expect(searchHits(tree, '   ')).toBeNull();
  });
});
