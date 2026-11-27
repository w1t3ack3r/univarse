// Spec 0042: the tree as the page draws it, from the API's flat list (Q14). Pure, so the chart, the search and the
// move form share one reading of it, and it's unit-tested. The API decides every rule again; this only keeps the
// page from offering what it would refuse.
import type { Unit, UnitType } from './words';

export interface Tree {
  readonly byId: ReadonlyMap<string, Unit>;
  /** Each unit's children, in the API's order (by name). */
  readonly children: ReadonlyMap<string, readonly Unit[]>;
  /** The units drawn at the top: the root, or for a caller with a scoped grant, the top of each part they see. */
  readonly tops: readonly Unit[];
}

export function buildTree(units: readonly Unit[]): Tree {
  const byId = new Map(units.map((u) => [u.id, u]));
  const children = new Map<string, Unit[]>();
  const tops: Unit[] = [];
  for (const u of units) {
    if (u.parentId && byId.has(u.parentId)) {
      const list = children.get(u.parentId) ?? [];
      list.push(u);
      children.set(u.parentId, list);
    } else tops.push(u);
  }
  return { byId, children, tops };
}

/** The unit's ancestors in the list, nearest last (the root first). */
export function ancestorsOf(tree: Tree, id: string): Unit[] {
  const out: Unit[] = [];
  const seen = new Set<string>();
  let cur = tree.byId.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const u = tree.byId.get(cur);
    if (!u) break;
    out.unshift(u);
    cur = u.parentId;
  }
  return out;
}

/** The ids of the unit and everything under it. */
export function subtreeIds(tree: Tree, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (x: string) => {
    if (out.has(x)) return;
    out.add(x);
    for (const c of tree.children.get(x) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

/** The types a unit of `parent`'s type may hold; the root (no type) holds every active type. */
export function allowedChildTypes(parent: Unit, types: readonly UnitType[]): UnitType[] {
  const active = types.filter((t) => t.status === 'ACTIVE');
  if (parent.typeId === null) return active;
  const parentType = types.find((t) => t.id === parent.typeId);
  if (!parentType) return [];
  return active.filter((t) => parentType.mayContain.includes(t.key));
}

/** Where `unit` may move: active units, not itself or under it, not its parent, whose type may hold its type. */
export function moveTargets(tree: Tree, unit: Unit, types: readonly UnitType[]): Unit[] {
  const own = subtreeIds(tree, unit.id);
  const type = types.find((t) => t.id === unit.typeId);
  if (!type) return [];
  return [...tree.byId.values()].filter((p) => {
    if (own.has(p.id) || p.id === unit.parentId || p.state !== 'ACTIVE') return false;
    if (p.typeId === null) return true;
    return types.find((t) => t.id === p.typeId)?.mayContain.includes(type.key) ?? false;
  });
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Q3's search: the units whose name or code holds the query, and every ancestor of one (so the chart can show the
 * path to it). `null` when there's no query: everything shows.
 */
export function searchHits(
  tree: Tree,
  query: string,
): { matches: Set<string>; shown: Set<string> } | null {
  const q = fold(query.trim());
  if (!q) return null;
  const matches = new Set<string>();
  for (const u of tree.byId.values())
    if (fold(u.name).includes(q) || (u.code !== null && fold(u.code).includes(q)))
      matches.add(u.id);
  const shown = new Set(matches);
  for (const id of matches) for (const a of ancestorsOf(tree, id)) shown.add(a.id);
  return { matches, shown };
}
