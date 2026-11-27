// The base every institution starts with, on the tenant side: its org root and its system roles with their
// permissions. Idempotent on natural keys. The seed and provisioning's seed step (spec 0034 Q5) both call it, so a
// provisioned institution and a seeded one start the same way. It never creates an account.
import { EVERY_ROLE_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@univarse/contracts';
import { lagosDay } from './org-units.js';
import type { TenantTx } from './tenant.js';

/**
 * Spec 0042: the institution's root unit, if it has none. The root is the institution (no type, Q4); its code is
 * reserved (Q8) and its history starts (Q6). The path names the root's own id, so it's written once the id exists; the
 * tree's check runs at commit. Returns the root's id.
 */
export async function ensureRoot(tx: TenantTx, tenantId: string, institutionName: string): Promise<string> {
  const existing = await tx.orgUnit.findUnique({ where: { tenantId_code: { tenantId, code: 'ROOT' } }, select: { id: true } });
  if (existing) return existing.id;
  const root = await tx.orgUnit.create({ data: { tenantId, code: 'ROOT', name: institutionName, kind: 'ACADEMIC', type: 'INSTITUTION', path: '/' }, select: { id: true } });
  await tx.orgUnit.update({ where: { id: root.id }, data: { path: `/${root.id}/` } });
  await tx.orgUnitCode.create({ data: { tenantId, code: 'ROOT', unitId: root.id } });
  await tx.orgUnitChange.create({ data: { tenantId, unitId: root.id, kind: 'CREATED', code: 'ROOT', name: institutionName, state: 'ACTIVE', effectiveFrom: lagosDay() } });
  return root.id;
}

/** Sets the base up in `tx` (already scoped to `tenantId` by RLS); returns each system role's id by key. */
export async function seedTenantBase(tx: TenantTx, tenantId: string, institutionName: string): Promise<Map<string, string>> {
  await ensureRoot(tx, tenantId, institutionName);
  const roleIds = new Map<string, string>();
  for (const [key, name] of SYSTEM_ROLES) {
    const permissions = [...new Set([...(SYSTEM_ROLE_PERMISSIONS[key] ?? []), ...EVERY_ROLE_PERMISSIONS])];
    const role = await tx.role.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { name, permissions },
      create: { tenantId, key, name, isSystem: true, permissions },
    });
    roleIds.set(key, role.id);
  }
  return roleIds;
}
