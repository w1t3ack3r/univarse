// Spec 0042 Q1, Q-A4: the institution's unit types, projected from its profile once. An institution that already has
// unit types keeps them as they are: a type it archived, or a rule it removed, never comes back from an assignment.
import type { TenantTx } from './tenant.js';

/** A profile's unit type, as spec 0041's snapshot holds it (lower-case kind; `mayContain` names keys). */
export interface ProjectableUnitType {
  readonly key: string;
  readonly name: string;
  readonly kind: 'academic' | 'administrative' | 'research';
  readonly mayContain: readonly string[];
}

const KIND = { academic: 'ACADEMIC', administrative: 'ADMINISTRATIVE', research: 'RESEARCH' } as const;

/** Writes the types and their rules in `tx` (scoped to `tenantId`) if it has none. Returns how many types it wrote. */
export async function projectUnitTypes(tx: TenantTx, tenantId: string, types: readonly ProjectableUnitType[]): Promise<number> {
  if ((await tx.unitType.count()) > 0) return 0;
  const ids = new Map<string, string>();
  for (const [i, t] of types.entries()) {
    const row = await tx.unitType.create({ data: { tenantId, key: t.key, name: t.name, kind: KIND[t.kind], sortOrder: i }, select: { id: true } });
    ids.set(t.key, row.id);
  }
  const rules = types.flatMap((t) =>
    t.mayContain.flatMap((child) => {
      const parentTypeId = ids.get(t.key);
      const childTypeId = ids.get(child);
      return parentTypeId && childTypeId ? [{ tenantId, parentTypeId, childTypeId }] : [];
    }),
  );
  if (rules.length > 0) await tx.unitTypeRule.createMany({ data: rules });
  return types.length;
}

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });

/** A calendar day (`YYYY-MM-DD`) as the `Date` Prisma writes into a `date` column. */
export const calendarDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Today in `Africa/Lagos`, as a `date` column's value. */
export const lagosDay = (now = new Date()): Date => calendarDay(LAGOS_DAY.format(now));
