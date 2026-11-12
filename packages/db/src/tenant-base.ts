// The base every institution starts with, on the tenant side: its org root and its system roles with their
// permissions. Idempotent on natural keys. The seed and provisioning's seed step (spec 0034 Q5) both call it, so a
// provisioned institution and a seeded one start the same way. It never creates an account.
import { EVERY_ROLE_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@univarse/contracts';
import type { TenantTx } from './tenant.js';

/** Sets the base up in `tx` (already scoped to `tenantId` by RLS); returns each system role's id by key. */
export async function seedTenantBase(tx: TenantTx, tenantId: string, institutionName: string): Promise<Map<string, string>> {
  const root = await tx.orgUnit.upsert({
    where: { tenantId_code: { tenantId, code: 'ROOT' } },
    update: {},
    create: { tenantId, code: 'ROOT', name: institutionName, kind: 'ACADEMIC', type: 'INSTITUTION', path: '/' },
  });
  if (root.path === '/') {
    await tx.orgUnit.update({ where: { id: root.id }, data: { path: `/${root.id}/` } });
  }
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
