// Tenant settings registry (spec 0007 ST1). The only place a setting key exists. The API validates
// writes and stored values with these schemas, and the web form uses the same ones.
import { z } from 'zod';
import type { Permission } from './permissions.js';
import type { ProductKey } from './products.js';

export type SettingScope = 'INSTITUTION' | 'ORG_UNIT' | 'PROGRAMME';

export interface SettingDef<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly default: z.infer<S>;
  readonly scopes: readonly SettingScope[];
  /** Owning product: the key is 404 while that product isn't active for the tenant (spec 0003). */
  readonly product: ProductKey;
  /** Who may change it. Narrow per area (spec 0007 D3); reading needs `settings.tenant.view`. */
  readonly manage: Permission;
  /** Applies from a date or session (later keys). False: takes effect when it changes. */
  readonly effectiveDated: boolean;
  /** Values are redacted in audit events. */
  readonly sensitive: boolean;
  /** Plain-language name for the UI. */
  readonly label: string;
}

const units = z
  .number({ error: 'Enter a whole number.' })
  .int({ error: 'Enter a whole number.' })
  .min(1, { error: 'Must be at least 1.' })
  .max(60, { error: 'Must be 60 or fewer.' });

export const UnitLimits = z
  .object({ min: units, max: units })
  .strict()
  .refine((v) => v.min <= v.max, { path: ['max'], error: 'The maximum must be at least the minimum.' })
  // JSON Schema can't compare two fields, so the document states it as a runtime rule (spec 0011).
  .meta({ description: 'Runtime rule (not expressible in JSON Schema): min ≤ max, otherwise 422 settings.invalid_value.' });

export const SETTINGS = {
  /**
   * docs/04 §5. 15 and 24 are configurable demo defaults; each institution sets its own (spec 0007 D1).
   * Not yet enforced: course registration consumes it in Phase 4.
   */
  'registration.unitLimits': {
    schema: UnitLimits,
    default: { min: 15, max: 24 },
    scopes: ['INSTITUTION'],
    product: 'academics',
    manage: 'settings.registration.manage',
    effectiveDated: false,
    sensitive: false,
    label: 'Units per semester',
  },
  /** Spec 0010 D3: bytes of uploaded files a tenant may hold (pending, scanning and clean). */
  'files.storageQuotaBytes': {
    schema: z.int({ error: 'Enter a whole number of bytes.' }).min(0).max(10 * 1024 ** 4),
    default: 1024 ** 3,
    scopes: ['INSTITUTION'],
    product: 'core',
    manage: 'settings.tenant.manage',
    effectiveDated: false,
    sensitive: false,
    label: 'Storage for uploaded documents',
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** The read shape every client sees (ST2, ST6). */
export interface SettingView<K extends SettingKey = SettingKey> {
  readonly key: K;
  readonly label: string;
  readonly value: SettingValue<K>;
  readonly default: SettingValue<K>;
  readonly source: 'default' | 'tenant';
  /** 0 while on the default. Sent back as `If-Match: "v{version}"`. */
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly id: string; readonly displayName: string } | null;
  /** Whether this user may change it (drives the UI; the API still checks). */
  readonly canManage: boolean;
}
