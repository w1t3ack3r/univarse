// Test-only (never in the API build): a small tree written as the API writes one (spec 0042): the root, the
// university profile's unit types if the institution has none, then each unit with its type, its path, its code's
// reservation and its CREATED change, so the database's own checks pass at commit.
import { ensureRoot, lagosDay, projectUnitTypes, withTenantTx, type TenantShardClient } from '@univarse/db';
import { childPath, legacyColumns, TEMPLATES } from '@univarse/domain';

export interface TestUnit {
  /** The name the test refers to it by. */
  readonly ref: string;
  /** A unit type of the university profile: `faculty`, `department`, `directorate`… */
  readonly type: string;
  readonly name: string;
  readonly code?: string;
  /** Another unit's `ref`; the root if left out. */
  readonly parent?: string;
}

/** Writes the root and `units` in one transaction; returns each unit's id by `ref`, and the root's as `ROOT`. */
export async function testTree(shard: TenantShardClient, tenantId: string, units: readonly TestUnit[], institutionName = 'Test Institution'): Promise<Record<string, string>> {
  return withTenantTx(shard, tenantId, async (tx) => {
    const ids: Record<string, string> = { ROOT: await ensureRoot(tx, tenantId, institutionName) };
    await projectUnitTypes(tx, tenantId, TEMPLATES.university.profile.unitTypes);
    const types = new Map((await tx.unitType.findMany({ select: { id: true, key: true, kind: true } })).map((t) => [t.key, t]));
    for (const u of units) {
      const type = types.get(u.type);
      if (!type) throw new Error(`no unit type ${u.type}`);
      const parentId = ids[u.parent ?? 'ROOT'];
      if (!parentId) throw new Error(`no unit ${u.parent ?? 'ROOT'} yet`);
      const parent = await tx.orgUnit.findUniqueOrThrow({ where: { id: parentId }, select: { path: true } });
      const row = await tx.orgUnit.create({
        data: { tenantId, code: u.code ?? null, name: u.name, typeId: type.id, parentId, path: parent.path, state: 'ACTIVE', ...legacyColumns(type.kind, type.key, 'ACTIVE') },
        select: { id: true },
      });
      await tx.orgUnit.update({ where: { id: row.id }, data: { path: childPath(parent.path, row.id) } });
      if (u.code) await tx.orgUnitCode.create({ data: { tenantId, code: u.code, unitId: row.id } });
      await tx.orgUnitChange.create({ data: { tenantId, unitId: row.id, kind: 'CREATED', code: u.code ?? null, name: u.name, typeId: type.id, parentId, state: 'ACTIVE', effectiveFrom: lagosDay() } });
      ids[u.ref] = row.id;
    }
    return ids;
  });
}
