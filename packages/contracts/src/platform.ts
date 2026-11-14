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
  /** Spec 0037 Q12. */
  releaseRing: z.enum(['PILOT', 'GENERAL']),
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

/** Spec 0034. */
const provisioningStepKey = z.enum(['place', 'key', 'seed', 'template', 'host', 'products', 'invite', 'done']);
const provisioningError = z.enum(['no_shard', 'shard_unavailable', 'key_unavailable', 'invite_unreadable', 'state_conflict', 'database', 'unexpected']);
const provisioningView = z.strictObject({
  jobId: z.uuid(),
  tenantId: z.uuid(),
  template: z.string(),
  status: z.enum(['QUEUED', 'RUNNING', 'FAILED', 'DONE']),
  /** Q7: the IT Admin's address as the console may show it. */
  invite: z.string(),
  steps: z.array(
    z.strictObject({
      step: provisioningStepKey,
      status: z.enum(['PENDING', 'RUNNING', 'DONE', 'FAILED']),
      attempts: z.number().int(),
      errorCode: provisioningError.nullable(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
    }),
  ),
  error: z.strictObject({ step: provisioningStepKey, code: provisioningError }).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
const goLiveItem = z.enum(['admin_ready', 'products', 'branding', 'regulatory', 'dpa']);

const reviewedMember = z.strictObject({
  id: z.uuid(),
  displayName: z.string(),
  role,
  isActive: z.boolean(),
  mfaEnrolled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});

/** Spec 0037 Q2, Q3 (E4): a two-person request, as the console shows it. */
const approvalKind = z.enum(['staff.make_owner']);
/** Spec 0037 Q9, Q12: notices and rings. */
const noticeKind = z.enum(['ANNOUNCEMENT', 'MAINTENANCE', 'RELEASE_NOTE']);
const noticeAudience = z.enum(['ALL', 'TENANTS', 'RING']);
const releaseRing = z.enum(['PILOT', 'GENERAL']);
const noticeStatus = z.enum(['DRAFT', 'PUBLISHED', 'WITHDRAWN']);
const who = z.strictObject({ id: z.uuid(), name: z.string().nullable() });
const institutionRef = z.strictObject({ id: z.uuid(), slug: z.string(), name: z.string() });
/** A draft as written. Lengths and the window are the domain's rules (noticeProblems); a draft may be saved unfinished. */
const noticeDraft = z.strictObject({
  kind: noticeKind,
  title: z.string().max(200),
  body: z.string().max(4000),
  audience: noticeAudience,
  ring: releaseRing.nullable().optional(),
  tenantIds: z.array(z.uuid()).max(200).optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const noticeSummary = z.strictObject({
  id: z.uuid(),
  kind: noticeKind,
  title: z.string(),
  audience: noticeAudience,
  ring: releaseRing.nullable(),
  status: noticeStatus,
  /** Published and still showing (not withdrawn, not past its end). */
  live: z.boolean(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  shownUntil: z.iso.datetime().nullable(),
  institutions: z.number().int(),
});
const noticeView = z.strictObject({
  ...noticeSummary.shape,
  body: z.string(),
  tenants: z.array(institutionRef),
  createdBy: who,
  publishedBy: who.nullable(),
  withdrawnBy: who.nullable(),
  withdrawnAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  /** What stops a draft being published now, as field and problem codes. Empty once it may be. */
  problems: z.array(z.strictObject({ path: z.string(), code: z.string() })),
  /** The institutions it reached, once published. */
  deliveries: z.array(z.strictObject({ tenant: institutionRef, withdrawnAt: z.iso.datetime().nullable() })),
});

/** Spec 0037 Q6: the fixed list (packages/domain SUSPENSION_REASONS). Non-payment isn't a reason. */
const suspensionReason = z.enum(['SECURITY_INCIDENT', 'REGULATOR_ORDER', 'CONTRACT_ENDED', 'INSTITUTION_ASKED', 'OTHER']);
const suspensionView = z.strictObject({
  id: z.uuid(),
  reason: suspensionReason,
  /** Staff only: never shown at the institution. */
  note: z.string().nullable(),
  previousStatus: z.enum(['ACTIVE', 'ONBOARDING']),
  suspendedAt: z.iso.datetime(),
  suspendedBy: z.strictObject({ id: z.uuid(), name: z.string().nullable() }),
  resumedAt: z.iso.datetime().nullable(),
  resumedBy: z.strictObject({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  /** Q7: when the worker ended the institution's sessions, and how many; null while it's still to do. */
  sessionsEndedAt: z.iso.datetime().nullable(),
  sessionsEnded: z.number().int().nullable(),
});
const approvalStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTED', 'FAILED']);
const approvalFailure = z.enum(['subject_gone', 'subject_inactive', 'already_done', 'state_conflict']);
const person = z.strictObject({ id: z.uuid(), name: z.string().nullable() });
const approvalView = z.strictObject({
  id: z.uuid(),
  kind: approvalKind,
  /** Exactly what will run. */
  payload: z.record(z.string(), z.unknown()),
  /** SHA-256 of the payload's canonical form: the approver sends this back (Q3). */
  payloadHash: z.string(),
  /** The member the payload names, who can't approve it. */
  subject: person.nullable(),
  reason: z.string(),
  /** A PENDING request past its expiry reads as EXPIRED. */
  status: approvalStatus,
  requestedBy: person,
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedBy: person.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  executedAt: z.iso.datetime().nullable(),
  failureCode: approvalFailure.nullable(),
  /** Whether the signed-in member may approve or reject it now, and may cancel it. */
  canDecide: z.boolean(),
  canCancel: z.boolean(),
});
const approvalRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('staff.make_owner'), payload: z.strictObject({ memberId: z.uuid() }), reason: z.string().trim().min(3).max(500) }),
]);

/** Spec 0037 Q15 (E25): one thing in the inbox. Computed when read; it leaves when its cause is resolved. */
const inboxItem = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('approval_waiting'), approvalId: z.uuid(), kind: approvalKind, requestedBy: person, expiresAt: z.iso.datetime() }),
  z.strictObject({ type: z.literal('approval_decided'), approvalId: z.uuid(), kind: approvalKind, status: approvalStatus, decidedAt: z.iso.datetime() }),
  z.strictObject({ type: z.literal('provisioning_failed'), tenant: institution, step: provisioningStepKey, code: provisioningError, failedAt: z.iso.datetime() }),
  z.strictObject({ type: z.literal('security_act'), event: z.string(), count: z.number().int(), lastSeenAt: z.iso.datetime(), tenant: institution.nullable() }),
]);

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
  /** Spec 0037. */
  approvals: { response: z.strictObject({ data: z.array(approvalView) }) },
  approval: { response: approvalView },
  requestApproval: { body: approvalRequest, response: approvalView },
  approve: { body: z.strictObject({ payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }), response: approvalView },
  inbox: { response: z.strictObject({ items: z.array(inboxItem), count: z.number().int() }) },
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
      /** Spec 0034 Q6: the template it was provisioned from (`polytechnic@1`); null for the seed's. */
      template: z.string().nullable(),
      /** Spec 0037 Q6: its suspensions, newest first (the open one, if any, is first), at most 10. */
      suspensions: z.array(suspensionView),
      /** Spec 0037 Q11: the notices it got, newest first, at most 10. */
      notices: z.array(z.strictObject({ id: z.uuid(), kind: noticeKind, title: z.string(), publishedAt: z.iso.datetime(), live: z.boolean(), withdrawnAt: z.iso.datetime().nullable() })),
    }),
  },
  /** Spec 0037 Q6. The note is required for OTHER, 3 to 200 characters; checked by the domain's rule too. */
  suspend: { body: z.strictObject({ reason: suspensionReason, note: z.string().trim().max(200).optional() }) },
  /** Spec 0037 Q12. */
  ring: { body: z.strictObject({ ring: releaseRing }) },
  /** Spec 0037 Q9. */
  notices: {
    query: z.strictObject({ status: noticeStatus.optional() }),
    response: z.strictObject({ data: z.array(noticeSummary) }),
  },
  notice: { response: noticeView },
  noticeDraft: { body: noticeDraft, response: noticeView },
  /** Spec 0034 Q5, Q13: creating starts a provisioning. The IT Admin's details go no further than the sealed invite. */
  createTenant: {
    body: z.strictObject({
      slug: z.string().trim().min(3).max(40),
      legalName: z.string().trim().min(3).max(200),
      shortName: z.string().trim().min(2).max(40),
      type: tenantType,
      ownership: tenantOwnership,
      template: z.enum(['university', 'polytechnic', 'college-of-education']),
      state: z.enum(NIGERIAN_STATES).nullable(),
      /** Entitled at step 6; core is always included. */
      products: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(20),
      admin: z.strictObject({
        displayName,
        email,
        username: z
          .string()
          .trim()
          .toUpperCase()
          .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{2,39}$/, 'letters, digits and / . _ -, 3 to 40')),
      }),
    }),
    response: z.strictObject({ tenantId: z.uuid(), jobId: z.uuid() }),
  },
  provisioning: { response: provisioningView },
  goLive: {
    response: z.strictObject({
      status: tenantStatus,
      items: z.array(z.strictObject({ item: goLiveItem, passed: z.boolean() })),
      ready: z.boolean(),
      dpa: z.strictObject({ dpaVersion: z.string(), signedOn: z.iso.date(), reference: z.string(), recordedAt: z.iso.datetime(), version: z.number().int() }).nullable(),
    }),
  },
  /** Q10. `signedOn` can't be in the future; that is checked against the server's date. */
  tenantDpa: {
    body: z.strictObject({
      dpaVersion: z.string().trim().min(1).max(40),
      signedOn: z.iso.date(),
      reference: z.string().trim().min(3).max(200),
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
export type PlatformCreateTenant = z.infer<typeof PlatformOps.createTenant.body>;
export type PlatformProvisioning = z.infer<typeof PlatformOps.provisioning.response>;
export type PlatformGoLive = z.infer<typeof PlatformOps.goLive.response>;
export type PlatformApproval = z.infer<typeof PlatformOps.approval.response>;
export type PlatformApprovalRequest = z.infer<typeof PlatformOps.requestApproval.body>;
export type PlatformInbox = z.infer<typeof PlatformOps.inbox.response>;
export type PlatformInboxItem = PlatformInbox['items'][number];
export type PlatformSuspension = z.infer<typeof suspensionView>;
export type PlatformNotice = z.infer<typeof noticeView>;
export type PlatformTenantSummary = z.infer<typeof tenantSummary>;
export type PlatformNoticeSummary = z.infer<typeof noticeSummary>;
export type PlatformNoticeDraft = z.infer<typeof noticeDraft>;
export type PlatformSuspensionReason = z.infer<typeof suspensionReason>;
