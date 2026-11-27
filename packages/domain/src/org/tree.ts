// Spec 0042 (P2-S1): the org tree's rules, as pure functions. The API checks them before it writes; the database
// checks the structural ones again at commit (a deferred trigger), so a bug here can't store a cycle.

/** A unit's own status (Q5). `INACTIVE` is reversible and stays in the tree; `ARCHIVED` is closed and hidden. */
export type UnitState = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
/** A unit type's kind (Q1), fixed when the type is made. */
export type UnitTypeKind = 'ACADEMIC' | 'ADMINISTRATIVE' | 'RESEARCH';

/** Q3's guards against a runaway structure. `[VERIFY]` until the pilot's real files test them. */
export const ORG_LIMITS = Object.freeze({ maxDepthBelowRoot: 8, maxUnits: 5000 });

/** A unit type as the rules see it. `mayContain` holds the ids of the types it may contain. */
export interface TypeRef {
  readonly id: string;
  readonly kind: UnitTypeKind;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly mayContain: readonly string[];
}

/** A unit as the rules see it. The root has no type. */
export interface UnitRef {
  readonly id: string;
  readonly parentId: string | null;
  /** The materialised path of ids, `/<root>/<faculty>/<dept>/`, the unit's own id last. */
  readonly path: string;
  readonly state: UnitState;
  readonly typeId: string | null;
}

/** A refused change: a stable code (docs/06 §4) and the words for the person who tried. */
export interface OrgProblem {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, number | string>>;
}

const problem = (code: string, message: string, details?: Readonly<Record<string, number | string>>): OrgProblem =>
  details ? { code, message, details } : { code, message };

/** A child's path: its parent's, then its own id. */
export const childPath = (parentPath: string, id: string): string => `${parentPath}${id}/`;

/** How far below the root a path is: the root is 0, a faculty 1, its department 2. */
export const depthBelowRoot = (path: string): number => path.split('/').filter(Boolean).length - 1;

/** Whether the path runs through the unit (the unit itself included). Q13's scope rule rests on this. */
export const isWithin = (path: string, unitId: string): boolean => path.includes(`/${unitId}/`);

/** Whether a unit of `childType` may sit under a parent of `parentType`. The root (no type) takes every type. */
export const mayContain = (parentType: TypeRef | null, childTypeId: string): boolean =>
  parentType === null || parentType.mayContain.includes(childTypeId);

/** Q3: where a new unit may be created. */
export function placementProblem(i: { parent: UnitRef; parentType: TypeRef | null; childType: TypeRef }): OrgProblem | null {
  if (i.parent.state !== 'ACTIVE') return problem('org.unit.parent_not_active', 'A unit can only be added under an active unit.');
  if (i.childType.status !== 'ACTIVE') return problem('org.unit.type_archived', 'That unit type is archived. Choose another type.');
  if (!mayContain(i.parentType, i.childType.id)) return problem('org.unit.type_not_allowed', 'That type of unit can’t sit under this unit.');
  if (depthBelowRoot(i.parent.path) + 1 > ORG_LIMITS.maxDepthBelowRoot) {
    return problem('org.unit.too_deep', `The tree can’t go more than ${String(ORG_LIMITS.maxDepthBelowRoot)} levels below the institution.`, { limit: ORG_LIMITS.maxDepthBelowRoot });
  }
  return null;
}

/** Q3: the institution's unit count, checked before a create. */
export function capacityProblem(units: number): OrgProblem | null {
  return units >= ORG_LIMITS.maxUnits
    ? problem('org.unit.limit_reached', `An institution can have at most ${String(ORG_LIMITS.maxUnits)} units.`, { limit: ORG_LIMITS.maxUnits })
    : null;
}

/**
 * Q3, Q11: where a unit may move. `subtreeHeight` is how many levels its deepest descendant sits below it (0 for a
 * leaf), so the whole subtree stays inside the depth limit.
 */
export function moveProblem(i: { unit: UnitRef; unitType: TypeRef | null; newParent: UnitRef; newParentType: TypeRef | null; subtreeHeight: number }): OrgProblem | null {
  if (i.unit.parentId === null || i.unitType === null) return problem('org.unit.root_fixed', 'The institution itself can’t be moved.');
  if (i.unit.state === 'ARCHIVED') return problem('org.unit.archived', 'An archived unit can’t be moved. Reactivate it first.');
  if (i.newParent.id === i.unit.id || isWithin(i.newParent.path, i.unit.id)) {
    return problem('org.unit.cycle', 'A unit can’t move under itself or one of its own units.');
  }
  if (i.newParent.id === i.unit.parentId) return problem('org.unit.same_parent', 'The unit is already there.');
  if (i.newParent.state !== 'ACTIVE') return problem('org.unit.parent_not_active', 'A unit can only move under an active unit.');
  if (!mayContain(i.newParentType, i.unitType.id)) return problem('org.unit.type_not_allowed', 'That type of unit can’t sit under this unit.');
  if (depthBelowRoot(i.newParent.path) + 1 + i.subtreeHeight > ORG_LIMITS.maxDepthBelowRoot) {
    return problem('org.unit.too_deep', `The tree can’t go more than ${String(ORG_LIMITS.maxDepthBelowRoot)} levels below the institution.`, { limit: ORG_LIMITS.maxDepthBelowRoot });
  }
  return null;
}

/** Q5: deactivating keeps the unit in the tree; its children stay as they are, and it takes no new one. */
export function deactivateProblem(unit: UnitRef): OrgProblem | null {
  if (unit.parentId === null) return problem('org.unit.root_fixed', 'The institution itself can’t be deactivated.');
  if (unit.state !== 'ACTIVE') return problem('org.unit.not_active', 'Only an active unit can be deactivated.');
  return null;
}

/** Q3, Q5: archiving is leaf first. `openChildren` counts the children not yet archived. */
export function archiveProblem(unit: UnitRef, openChildren: number): OrgProblem | null {
  if (unit.parentId === null) return problem('org.unit.root_fixed', 'The institution itself can’t be archived.');
  if (unit.state === 'ARCHIVED') return problem('org.unit.already_archived', 'The unit is already archived.');
  if (openChildren > 0) {
    return problem('org.unit.has_open_children', `Archive its ${String(openChildren)} unit${openChildren === 1 ? '' : 's'} first.`, { openChildren });
  }
  return null;
}

/** Q5: back to active, under an active parent. */
export function reactivateProblem(unit: UnitRef, parent: UnitRef | null): OrgProblem | null {
  if (unit.state === 'ACTIVE') return problem('org.unit.already_active', 'The unit is already active.');
  if (!parent || parent.state !== 'ACTIVE') return problem('org.unit.parent_not_active', 'Reactivate the unit above it first.');
  return null;
}

/** Q10: a new type for a unit fits its parent and its children, and keeps its kind. */
export function retypeProblem(i: { unit: UnitRef; currentType: TypeRef | null; newType: TypeRef; parentType: TypeRef | null; childTypeIds: readonly string[] }): OrgProblem | null {
  if (i.unit.parentId === null || i.currentType === null) return problem('org.unit.root_fixed', 'The institution itself has no unit type.');
  if (i.newType.id === i.currentType.id) return problem('org.unit.same_type', 'The unit already has that type.');
  if (i.newType.status !== 'ACTIVE') return problem('org.unit.type_archived', 'That unit type is archived. Choose another type.');
  if (i.newType.kind !== i.currentType.kind) return problem('org.unit.kind_change', 'A unit’s new type must be of the same kind (academic, administrative or research).');
  if (!mayContain(i.parentType, i.newType.id)) return problem('org.unit.type_not_allowed', 'That type of unit can’t sit under this unit.');
  const misfits = new Set(i.childTypeIds.filter((t) => !i.newType.mayContain.includes(t))).size;
  if (misfits > 0) return problem('org.unit.children_not_allowed', 'The new type can’t contain some of this unit’s units.', { childTypes: misfits });
  return null;
}

const CODE = /^[A-Z][A-Z0-9]{1,11}$/;

/** Q8: a code as typed, trimmed and upper-cased; empty means "no code yet". */
export function normaliseCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return code === '' ? null : code;
}

/** Q8: 2 to 12 letters and digits, starting with a letter. */
export function codeProblem(code: string): OrgProblem | null {
  return CODE.test(code) ? null : problem('org.unit.code_invalid', 'A code is 2 to 12 letters and digits, starting with a letter.');
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `YYYY-MM-DD` names a real calendar day. */
export function isCalendarDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today in `Africa/Lagos`, as `YYYY-MM-DD` (spec 0040: server time in the institution's zone). */
export const lagosToday = (now: Date): string => LAGOS_DAY.format(now);

/**
 * Q7: an effective date is a real day, today or earlier, and never before `notBefore` (the unit's last change, or a
 * new parent's creation). Dates compare as strings: `YYYY-MM-DD` sorts as it reads.
 */
export function effectiveDateProblem(date: string, today: string, notBefore: string | null): OrgProblem | null {
  if (!isCalendarDate(date)) return problem('org.unit.effective_date_invalid', 'Give the date as a calendar day.');
  if (date > today) return problem('org.unit.effective_date_future', 'A change can’t take effect in the future. Make it on the day.');
  if (notBefore !== null && date < notBefore) {
    return problem('org.unit.effective_date_out_of_order', `This change can’t take effect before ${notBefore}, the date of the change before it.`, { notBefore });
  }
  return null;
}

/** Q2: a new type's key, made once from its first name: lower-case `snake_case`, unique among the keys given. */
export function typeKeyFromName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'type';
  const start = /^[a-z]/.test(base) ? base : `type_${base}`.slice(0, 32);
  let key = start.length >= 2 ? start : `${start}_type`;
  for (let n = 2; taken.has(key); n += 1) key = `${start}_${String(n)}`;
  return key;
}

/** The old enum's values (Q16). */
export type LegacyUnitType = 'INSTITUTION' | 'COLLEGE' | 'FACULTY' | 'SCHOOL' | 'DEPARTMENT' | 'INSTITUTE' | 'CENTRE' | 'UNIT';
const LEGACY_TYPES: ReadonlySet<string> = new Set(['college', 'faculty', 'school', 'department', 'institute', 'centre', 'unit']);

/**
 * Q16: what the old `kind`, `type` and `status` columns hold, in values the earlier images can read, until the
 * contract release drops them.
 */
export function legacyColumns(typeKind: UnitTypeKind | null, typeKey: string | null, state: UnitState): { kind: 'ACADEMIC' | 'ADMINISTRATIVE'; type: LegacyUnitType; status: 'ACTIVE' | 'ARCHIVED' } {
  const type: LegacyUnitType = typeKey === null ? 'INSTITUTION' : LEGACY_TYPES.has(typeKey) ? (typeKey.toUpperCase() as LegacyUnitType) : 'UNIT';
  return { kind: typeKind === 'ADMINISTRATIVE' ? 'ADMINISTRATIVE' : 'ACADEMIC', type, status: state === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE' };
}
