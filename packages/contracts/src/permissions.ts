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
  'settings.tenant.view': { description: 'View institution settings and who changed them' },
  'settings.tenant.manage': { description: 'Change institution settings', privileged: true, stepUp: true },
  'settings.registration.manage': {
    description: 'Change course registration settings (registration keys only; spec 0007 D3)',
    privileged: true,
    stepUp: true,
  },
  'settings.product.manage': { description: 'Enable or disable products within the plan', privileged: true, stepUp: true },
  'audit.event.view': { description: 'View the audit log', privileged: true, sensitiveData: true },
  // Spec 0010 D2: own files only in this slice; every role holds them (EVERY_ROLE_PERMISSIONS).
  'files.file.upload': { description: 'Upload your own documents' },
  'files.file.read': { description: 'See and download your own documents', sensitiveData: true },
  'files.file.delete': { description: 'Delete your own documents' },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export const isPermission = (p: string): p is Permission => Object.hasOwn(PERMISSIONS, p);

/** Granted to every seeded role, on top of its own list (spec 0010 D2: everyone manages their own files). */
export const EVERY_ROLE_PERMISSIONS: readonly Permission[] = ['files.file.upload', 'files.file.read', 'files.file.delete'];

/** Default grants for seeded system roles. Tenants may extend roles later. */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  INSTITUTION_ADMIN: [
    'identity.user.view',
    'identity.user.manage',
    'identity.role.assign',
    'org.unit.view',
    'org.unit.manage',
    'settings.tenant.view',
    'settings.tenant.manage',
    'settings.product.manage',
    'audit.event.view',
  ],
  // Oversight of registration settings is by view + audit + role assignment, not by holding the manage
  // permission (spec 0007 ST5). The Registrar owns them.
  REGISTRAR: ['identity.user.view', 'org.unit.view', 'audit.event.view', 'settings.tenant.view', 'settings.registration.manage'],
  DEAN: ['org.unit.view'],
  HOD: ['org.unit.view'],
  LECTURER: ['org.unit.view'],
};
