// Spec 0028: the platform API's request and response shapes (the console's sign-in, account and staff). Strict: an
// unknown field is refused. Not part of the tenant API's OpenAPI document: the platform API serves the console only.
import { z } from 'zod';

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
} as const;
