// Spec 0011: one declaration per API handler (`@Contract(op)`). Permission, step-up, product and the
// enrolment-only allowance are NOT declared here: the generator reads them from the same decorator
// metadata the guards enforce, so the document can't disagree with what runs.
import type { z } from 'zod';

/**
 * A path parameter, described as the API checks it TODAY. The schema documents; it does not validate
 * (adding validation could turn the current 404 into a 400, or run before authorization).
 */
export interface PathParam {
  readonly schema: z.ZodType;
  readonly description: string;
  /** What an invalid or unknown value gets, after authorization. */
  readonly invalid: { readonly status: 404; readonly code: string };
}

export type CookieName = 'session' | 'mfaChallenge';

export interface ApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly tag: 'auth' | 'mfa' | 'users' | 'products' | 'settings' | 'files' | 'tenant' | 'operations';
  readonly params?: Readonly<Record<string, PathParam>>;
  /** The exact schema the handler passes to `parse` (OA3). */
  readonly body?: z.ZodType;
  /**
   * Settings only: the body's `value` is checked against the chosen key's registry schema by the use
   * case (422 settings.invalid_value), so the document derives one value shape per key.
   */
  readonly valueBySettingKey?: true;
  /** Settings only: writes also need the chosen key's own manage permission (spec 0007 ST4). */
  readonly permissionBySettingKey?: true;
  readonly success: 200 | 201 | 202 | 204;
  /** The success body (JSON) as serialized. Absent for 204 and for binary responses. */
  readonly response?: z.ZodType;
  /** A binary success: the media types the body may have (OA6). */
  readonly binary?: readonly string[];
  /**
   * Errors the use case produces, by status. Errors that follow from the route itself (tenant, product,
   * authentication, permission, step-up, validation, CSRF, rate limit, path parameters, If-Match and
   * 500) are derived by the generator and must not be repeated here.
   */
  readonly errors?: Readonly<Partial<Record<400 | 401 | 403 | 404 | 409 | 412 | 422 | 500 | 503, readonly string[]>>>;
  /** The success response carries an `ETag` (docs/06 §ETag). */
  readonly etag?: true;
  /** The request must send `If-Match` (428 if missing, 412 if stale). */
  readonly ifMatch?: true;
  /** The rate-limit buckets the use case applies (docs/06); declared, as no decorator records them. */
  readonly rateLimit?: string;
  /** `reads` replaces the session as this operation's credential (MFA verify reads the challenge). */
  readonly cookies?: { readonly reads?: CookieName; readonly sets?: readonly CookieName[]; readonly clears?: readonly CookieName[] };
}

/** Keeps each operation's literal types, so `parse(Ops.x.body, …)` stays typed. */
export const defineOperations = <const T extends Record<string, ApiOperation>>(ops: T): T => ops;
