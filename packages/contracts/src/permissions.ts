// Permission catalog — docs/08-security.md §4. Keys: <module>.<resource>.<action>.
// Flags drive enforcement: `privileged` ⇒ MFA required (docs/08 §3.2), `stepUp` ⇒ recent re-auth,
// `sensitiveData` ⇒ access is individually audited.

export interface PermissionDef {
  readonly description: string;
  readonly privileged?: boolean;
  readonly stepUp?: boolean;
  readonly sensitiveData?: boolean;
}

export const PERMISSIONS = {
  'identity.user.view': { description: 'View user accounts in scope' },
  'identity.user.manage': { description: 'Create, disable and update user accounts', privileged: true },
  'identity.role.assign': { description: 'Grant or revoke roles', privileged: true, stepUp: true },
  'org.unit.view': { description: 'View the organisation structure' },
  'org.unit.manage': { description: 'Create and edit org units', privileged: true },
  'settings.tenant.manage': { description: 'Change institution settings', privileged: true, stepUp: true },
  'settings.product.manage': { description: 'Enable or disable products within the plan', privileged: true, stepUp: true },
  'audit.event.view': { description: 'View the audit log', privileged: true, sensitiveData: true },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export const isPermission = (p: string): p is Permission => Object.hasOwn(PERMISSIONS, p);

/** Default grants for seeded system roles. Tenants may extend roles later. */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  INSTITUTION_ADMIN: [
    'identity.user.view',
    'identity.user.manage',
    'identity.role.assign',
    'org.unit.view',
    'org.unit.manage',
    'settings.tenant.manage',
    'settings.product.manage',
    'audit.event.view',
  ],
  REGISTRAR: ['identity.user.view', 'org.unit.view', 'audit.event.view'],
  DEAN: ['org.unit.view'],
  HOD: ['org.unit.view'],
  LECTURER: ['org.unit.view'],
};
