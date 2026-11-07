// Spec 0028: the platform API's request and response shapes (the console's sign-in, account and staff). Strict: an
// unknown field is refused. Not part of the tenant API's OpenAPI document: the platform API serves the console only.
import { z } from 'zod';
import { Cursor, Page, PageLimit } from './api/pagination.js';

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
  displayName: z.string(),
  role,
  isActive: z.boolean(),
  mfaEnrolled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type PlatformMember = z.infer<typeof PlatformMember>;

/** Spec 0031 Q2: the audit viewer's query. Strict: any other parameter is a 400. No free text over metadata. */
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
  staff: { response: z.strictObject({ data: z.array(PlatformMember) }) },
  invite: { body: z.strictObject({ email, displayName, role }), response: PlatformMember },
  changeRole: { body: z.strictObject({ role }), response: PlatformMember },
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
