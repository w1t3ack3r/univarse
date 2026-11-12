/**
 * Spec 0034: provisioning's rules. Pure, so they're tested without a database: the slug a new institution may take,
 * the steps a provisioning runs and in what order, the templates (E13), and the go-live checklist (E6).
 */
import { isReservedName } from './reserved-names.js';
import type { TenantStatusName, TenantTypeName } from './tenant-registry.js';

// ── The slug (Q5 step 0)

/**
 * A subdomain's first label: 3 to 40 lower-case letters, digits and single hyphens, starting with a letter and not
 * ending with a hyphen. Short enough to type, long enough for `fed-poly-ilaro`.
 */
const SLUG = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;

export type SlugProblem = 'format' | 'reserved';

/** Why a slug can't be used, or null. Uniqueness is the database's to decide. */
export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG.test(slug)) return 'format';
  if (isReservedName(slug)) return 'reserved';
  return null;
}

// ── The steps (Q5)

/** In order. Each is idempotent; a resumed job starts at the first one that isn't done. */
export const PROVISIONING_STEPS = ['place', 'key', 'seed', 'template', 'host', 'products', 'invite', 'done'] as const;
export type ProvisioningStepKey = (typeof PROVISIONING_STEPS)[number];

/**
 * The fixed codes a failed step reports (Q4). Never a message from a driver or Vault: these are all the console ever
 * sees, and each has a plain explanation there.
 */
export const PROVISIONING_ERRORS = [
  'no_shard',
  'shard_unavailable',
  'key_unavailable',
  'invite_unreadable',
  'state_conflict',
  'database',
  'unexpected',
] as const;
export type ProvisioningErrorCode = (typeof PROVISIONING_ERRORS)[number];

/** The step a job runs next, from its finished steps, or null when every step is done. */
export function nextStep(done: ReadonlySet<ProvisioningStepKey>): ProvisioningStepKey | null {
  return PROVISIONING_STEPS.find((s) => !done.has(s)) ?? null;
}

/** Each step expects the tenant in one status; anything else is a conflict, never a guess. */
export function statusBeforeStep(step: ProvisioningStepKey): TenantStatusName {
  return step === 'place' ? 'REQUESTED' : 'PROVISIONING';
}

// ── Templates (Q6, E13)

export type TemplateId = 'university' | 'polytechnic' | 'college-of-education';

export interface InstitutionTemplate {
  readonly id: TemplateId;
  readonly version: number;
  readonly label: string;
  /** The type that proposes it. */
  readonly forType: TenantTypeName;
  /**
   * The settings it writes, by key, only for keys the settings registry has today. Each later phase that adds a
   * setting adds its default here and a migration applies it to the institutions already provisioned (Q6).
   */
  readonly settings: Readonly<Record<string, unknown>>;
}

const COMMON_SETTINGS = Object.freeze({
  // docs/04 §5. `[VERIFY]` per institution: each sets its own limits after go-live.
  'registration.unitLimits': Object.freeze({ min: 15, max: 24 }),
});

export const TEMPLATES: Readonly<Record<TemplateId, InstitutionTemplate>> = Object.freeze({
  university: Object.freeze({ id: 'university', version: 1, label: 'University (NUC)', forType: 'UNIVERSITY', settings: COMMON_SETTINGS }),
  polytechnic: Object.freeze({ id: 'polytechnic', version: 1, label: 'Polytechnic (NBTE)', forType: 'POLYTECHNIC', settings: COMMON_SETTINGS }),
  'college-of-education': Object.freeze({
    id: 'college-of-education',
    version: 1,
    label: 'College of education (NCCE)',
    forType: 'COLLEGE_OF_EDUCATION',
    settings: COMMON_SETTINGS,
  }),
});

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
export const isTemplateId = (id: string): id is TemplateId => Object.hasOwn(TEMPLATES, id);

/** The template a type proposes (Q6). The console may choose another; this is the starting point. */
export function templateForType(type: TenantTypeName): TemplateId {
  return TEMPLATE_IDS.find((id) => TEMPLATES[id].forType === type) ?? 'university';
}

/** How a template is recorded on the tenant: `polytechnic@1`. */
export const templateRef = (t: InstitutionTemplate): string => `${t.id}@${String(t.version)}`;

// ── The go-live checklist (Q9)

export interface GoLiveFacts {
  readonly status: TenantStatusName;
  /** When the first institution administrator had activated and set up an authenticator, or null. */
  readonly adminReadyAt: Date | null;
  /** Entitled products, core included. */
  readonly entitled: readonly string[];
  readonly primaryColor: string | null;
  readonly state: string | null;
  readonly operatingStatus: string;
  readonly dpaRecorded: boolean;
}

export const GO_LIVE_ITEMS = ['admin_ready', 'products', 'branding', 'regulatory', 'dpa'] as const;
export type GoLiveItem = (typeof GO_LIVE_ITEMS)[number];

export interface GoLiveChecklist {
  readonly items: readonly { readonly item: GoLiveItem; readonly passed: boolean }[];
  /** Every item passes and the institution is ONBOARDING. */
  readonly ready: boolean;
}

/** Computed, never ticked (Q9). Only the DPA is recorded by hand (Q10). */
export function goLiveChecklist(f: GoLiveFacts): GoLiveChecklist {
  const passed: Record<GoLiveItem, boolean> = {
    admin_ready: f.adminReadyAt !== null,
    products: f.entitled.some((p) => p !== 'core'),
    branding: f.primaryColor !== null,
    regulatory: f.state !== null && f.operatingStatus !== 'UNKNOWN',
    dpa: f.dpaRecorded,
  };
  const items = GO_LIVE_ITEMS.map((item) => ({ item, passed: passed[item] }));
  return { items, ready: f.status === 'ONBOARDING' && items.every((i) => i.passed) };
}

/** The email the console may show after creation (Q7): the first letter, then the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0] ?? ''}•••${email.slice(at)}`;
}
