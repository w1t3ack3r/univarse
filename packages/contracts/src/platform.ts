// Spec 0028: the platform API's request and response shapes (the console's sign-in, account and staff). Strict: an
// unknown field is refused. Not part of the tenant API's OpenAPI document: the platform API serves the console only.
import { z } from 'zod';
import { Cursor, Page, PageLimit } from './api/pagination.js';
import { NIGERIAN_STATES } from './nigerian-states.js';

/** A staff email: trimmed and lower-cased before it is used or stored. */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(1).max(256);
const code = z.string().regex(/^\d{6}$/, 'a 6-digit code');
const recoveryCode = z.string().trim().min(10).max(16);
const role = z.enum(['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'READ_ONLY']);
const displayName = z.string().trim().min(2).max(80);

/** A second factor: a TOTP code or a recovery code, exactly one. */
const secondFactor = z.union([z.strictObject({ code }), z.strictObject({ recoveryCode })]);

/** What the console shows next after an identity step. */
export const PlatformNext = z.enum(['mfa', 'enrol', 'recovery-codes', 'home']);
export type PlatformNext = z.infer<typeof PlatformNext>;

export const PlatformMember = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  /** Spec 0032 Q11: the address has been proven. Unproven is why someone may be getting no mail. */
  emailVerified: z.boolean(),
  displayName: z.string(),
  role,
  isActive: z.boolean(),
  mfaEnrolled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type PlatformMember = z.infer<typeof PlatformMember>;

/** Spec 0031 Q2: the audit viewer's query. Strict: any other parameter is a 400. No free text over metadata. */
const tenantType = z.enum(['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION']);
const tenantOwnership = z.enum(['FEDERAL', 'STATE', 'PRIVATE']);
const tenantStatus = z.enum(['REQUESTED', 'PROVISIONING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED']);
const tenantSummary = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  legalName: z.string(),
  shortName: z.string(),
  type: tenantType,
  ownership: tenantOwnership,
  status: tenantStatus,
  tier: z.enum(['POOLED', 'DEDICATED']),
});
const nullableTrimmed = (max: number, pattern?: RegExp) => {
  const text = pattern ? z.string().trim().min(1).max(max).regex(pattern) : z.string().trim().min(1).max(max);
  return text.nullable();
};

const auditQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: PageLimit.optional(),
  /** One action, exactly. */
  action: z.string().regex(/^[a-z][a-z0-9_.]{1,120}$/).optional(),
  /** A group of actions: `platform.auth`, `crypto`. */
  actionGroup: z.string().regex(/^[a-z][a-z0-9_.]{0,80}$/).optional(),
  actorId: z.uuid().optional(),
  tenantId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const auditRow = z.strictObject({
  id: z.uuid(),
  seq: z.string(),
  occurredAt: z.iso.datetime(),
  action: z.string(),
  /** Spec 0031 Q4: a member, a member no longer on the platform (an id with no name), or the system. */
  actor: z.strictObject({ id: z.uuid().nullable(), name: z.string().nullable() }),
  tenant: z.strictObject({ id: z.uuid(), slug: z.string().nullable() }).nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const verificationRun = z.strictObject({
  id: z.uuid(),
  trigger: z.enum(['MEMBER', 'SCHEDULE']),
  startedBy: z.strictObject({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(['RUNNING', 'PASSED', 'FAILED', 'ERROR']),
  rowsChecked: z.string(),
  headSeq: z.string().nullable(),
  brokenAtSeq: z.string().nullable(),
  reason: z.string().nullable(),
});

const securityLevelCounts = z.strictObject({ act: z.number().int(), watch: z.number().int(), note: z.number().int() });
const institution = z.strictObject({ id: z.uuid(), slug: z.string().nullable(), name: z.string().nullable() });

const reviewedMember = z.strictObject({
  id: z.uuid(),
  displayName: z.string(),
  role,
  isActive: z.boolean(),
  mfaEnrolled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const PlatformOps = {
  activate: { body: z.strictObject({ email, code, password }), response: z.strictObject({ next: PlatformNext }) },
  login: { body: z.strictObject({ email, password }), response: z.strictObject({ next: PlatformNext }) },
  verifyMfa: { body: secondFactor, response: z.strictObject({ next: PlatformNext }) },
  requestPasswordReset: { body: z.strictObject({ email }) },
  confirmPasswordReset: { body: z.strictObject({ email, code, password }) },
  me: {
    response: z.strictObject({
      id: z.uuid(),
      email: z.string(),
      displayName: z.string(),
      role,
      /** What this session may do now: enrol (TOTP not yet set up), acknowledge (recovery codes shown), or everything. */
      state: z.enum(['enrol', 'recovery-codes', 'full']),
      permissions: z.array(z.string()),
    }),
  },
  beginEnrolment: { response: z.strictObject({ secret: z.string(), otpauthUri: z.string() }) },
  confirmEnrolment: { body: z.strictObject({ code }), response: z.strictObject({ recoveryCodes: z.array(z.string()) }) },
  stepUp: { body: secondFactor },
  regenerateRecoveryCodes: { response: z.strictObject({ recoveryCodes: z.array(z.string()) }) },
  sessions: {
    response: z.strictObject({
      data: z.array(
        z.strictObject({
          id: z.uuid(),
          current: z.boolean(),
          createdAt: z.iso.datetime(),
          lastSeenAt: z.iso.datetime(),
          ip: z.string().nullable(),
          userAgent: z.string().nullable(),
        }),
      ),
    }),
  },
  /** Spec 0032. The first answer is the same whatever the address (Q4). */
  contactChange: {
    pending: { response: z.strictObject({ pending: z.strictObject({ address: z.string(), expiresAt: z.iso.datetime() }).nullable() }) },
    request: { body: z.strictObject({ email }) },
    confirm: { body: z.strictObject({ code }) },
    confirmCorrection: { body: z.strictObject({ email, code, password }) },
    undo: { body: z.strictObject({ email, code: z.string().trim().min(10).max(16) }) },
    correct: { body: z.strictObject({ email, oldAddressWrong: z.boolean() }) },
  },
  staff: { response: z.strictObject({ data: z.array(PlatformMember) }) },
  invite: { body: z.strictObject({ email, displayName, role }), response: PlatformMember },
  changeRole: { body: z.strictObject({ role }), response: PlatformMember },
  /** Spec 0033. Strict: any other parameter is a 400. The slug appears in no body, so nothing can change it. */
  tenants: {
    query: z.strictObject({ cursor: Cursor.optional(), limit: PageLimit.optional(), status: tenantStatus.optional(), type: tenantType.optional(), q: z.string().trim().min(2).max(80).optional() }),
    response: z.strictObject({ data: z.array(tenantSummary), page: Page }),
  },
  tenant: {
    response: z.strictObject({
      ...tenantSummary.shape,
      version: z.number().int(),
      suspendedReason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      typeLocked: z.boolean(),
      shard: z.strictObject({ name: z.string(), kind: z.enum(['POOL', 'DEDICATED']), region: z.string() }),
      domains: z.array(z.strictObject({ hostname: z.string(), kind: z.enum(['SUBDOMAIN', 'CUSTOM']), verifiedAt: z.iso.datetime().nullable() })),
      products: z.array(z.strictObject({ product: z.string(), alwaysOn: z.boolean(), entitled: z.boolean(), enabled: z.boolean() })),
      keys: z.array(z.strictObject({ version: z.number().int(), status: z.enum(['ACTIVE', 'RETIRED', 'DESTROYED']), createdAt: z.iso.datetime(), retiredAt: z.iso.datetime().nullable(), destroyedAt: z.iso.datetime().nullable() })),
      regulatory: z.strictObject({
        regulator: z.enum(['NUC', 'NBTE', 'NCCE']),
        operatingStatus: z.enum(['UNKNOWN', 'APPROVED', 'PROVISIONAL_LICENCE', 'SUSPENDED_BY_REGULATOR']),
        state: z.string().nullable(),
        regulatorReference: z.string().nullable(),
        jambCode: z.string().nullable(),
        version: z.number().int(),
      }),
      branding: z.strictObject({ primaryColor: z.string().nullable(), textColor: z.string().nullable(), logoSha256: z.string().nullable() }),
    }),
  },
  tenantProfile: { body: z.strictObject({ legalName: z.string().trim().min(3).max(200), shortName: z.string().trim().min(2).max(40), ownership: tenantOwnership, type: tenantType }) },
  tenantRegulatory: {
    body: z.strictObject({
      operatingStatus: z.enum(['UNKNOWN', 'APPROVED', 'PROVISIONAL_LICENCE', 'SUSPENDED_BY_REGULATOR']),
      state: z.enum(NIGERIAN_STATES).nullable(),
      regulatorReference: nullableTrimmed(120),
      jambCode: nullableTrimmed(16, /^[A-Za-z0-9]+$/),
    }),
  },
  tenantColor: { body: z.strictObject({ primaryColor: z.string().regex(/^#[0-9A-F]{6}$/, 'a colour as #RRGGBB, in capitals').nullable() }) },
  /** Base64 of at most 256 KB; the bytes are judged in `packages/domain`. */
  tenantLogo: { body: z.strictObject({ base64: z.string().min(1).max(360_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }) },
  tenantProduct: {
    body: z.strictObject({
      entitled: z.boolean(),
      reason: z.string().trim().min(5).max(500),
      /** Revoking only: the institution's slug, typed (Q14). */
      confirmSlug: z.string().trim().max(63).optional(),
    }),
  },
  audit: { query: auditQuery, response: z.strictObject({ data: z.array(auditRow), page: Page }) },
  auditVerification: {
    response: z.strictObject({
      latest: verificationRun.nullable(),
      recent: z.array(verificationRun),
      /** The newest run that reached a verdict failed: the banner stays until a later run passes (Q6). */
      broken: z.boolean(),
    }),
  },
  startAuditVerification: { response: verificationRun },
  security: {
    query: z.strictObject({ window: z.enum(['24h', '7d', '30d']).optional(), tenantId: z.uuid().optional() }),
    response: z.strictObject({
      window: z.enum(['24h', '7d', '30d']),
      totals: securityLevelCounts,
      events: z.array(z.strictObject({ event: z.string(), level: z.enum(['act', 'watch', 'note']), count: z.number().int(), lastSeenAt: z.iso.datetime() })),
      institutions: z.array(z.strictObject({ institution, ...securityLevelCounts.shape })),
      series: z.array(z.strictObject({ at: z.iso.datetime(), ...securityLevelCounts.shape })),
    }),
  },
  accessReview: {
    response: z.strictObject({
      period: z.string(),
      status: z.enum(['done', 'due', 'overdue']),
      members: z.array(reviewedMember),
      /** What the page saw, sent back when attesting: a change since refuses it (Q15). */
      snapshotHash: z.string(),
      history: z.array(
        z.strictObject({
          id: z.uuid(),
          period: z.string(),
          reviewer: z.strictObject({ id: z.uuid(), name: z.string().nullable() }),
          attestedAt: z.iso.datetime(),
          members: z.number().int(),
          changesNeeded: z.number().int(),
        }),
      ),
    }),
  },
  attestAccessReview: {
    body: z.strictObject({
      snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
      decisions: z.array(z.strictObject({ memberId: z.uuid(), decision: z.enum(['keep', 'change']), note: z.string().trim().max(500).optional() })).max(500),
    }),
    response: z.strictObject({ period: z.string(), attestedAt: z.iso.datetime() }),
  },
} as const;

export type PlatformTenantList = z.infer<typeof PlatformOps.tenants.response>;
export type PlatformTenantDetail = z.infer<typeof PlatformOps.tenant.response>;
export type PlatformAuditLog = z.infer<typeof PlatformOps.audit.response>;
export type PlatformChainStatus = z.infer<typeof PlatformOps.auditVerification.response>;
export type PlatformSecuritySummary = z.infer<typeof PlatformOps.security.response>;
export type PlatformAccessReview = z.infer<typeof PlatformOps.accessReview.response>;
