// Request bodies for /api/v1/auth and /api/v1/auth/mfa (spec 0011 OA3). The handler's `parse` uses
// these exact objects, and the OpenAPI document is generated from them.
import { z } from 'zod';

const Identifier = z.string().trim().min(1).max(254);
const Password = z.string().min(1).max(256);
const TotpCode = z.string().regex(/^\d{6}$/);
const RecoveryCode = z.string().trim().min(10).max(20);

/** Activation and password reset both start with an identifier. */
export const CodeRequestBody = z.object({ username: Identifier }).strict();
/** …then identifier + emailed code + the new password (activation and reset alike). */
export const CodeConfirmBody = z.object({ username: Identifier, code: TotpCode, password: Password }).strict();

export const LoginBody = z.object({ username: Identifier, password: Password }).strict();

/** S2: password, plus a TOTP code or a recovery code for MFA users (never both). */
export const StepUpBody = z
  .object({ password: Password, code: TotpCode.optional(), recoveryCode: RecoveryCode.optional() })
  .strict()
  .refine((v) => !(v.code && v.recoveryCode), 'Send either code or recoveryCode, not both');

export const MfaVerifyBody = z.union([z.object({ code: TotpCode }).strict(), z.object({ recoveryCode: RecoveryCode }).strict()]);
export const MfaEnrolBody = z.object({ password: Password }).strict();
export const MfaConfirmBody = z.object({ code: TotpCode }).strict();
