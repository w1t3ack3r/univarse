// Spec 0028: what platform identity passes around. The signed-in member is a PlatformActor, read from the session on
// every request (never cached), so a deactivation or a revoked session takes effect on the next request.
import type { PlatformClient } from '@univarse/db';

export type PlatformTx = Parameters<Parameters<PlatformClient['$transaction']>[0]>[0];

export interface PlatformActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaAt: Date | null;
  readonly restricted: boolean;
  readonly stepUpAt: Date | null;
}

export interface RequestMeta {
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly requestId?: string;
}

/** Spec 0027 P6 (reserved there), spec 0028 Q8: host-only, Secure, HttpOnly, SameSite=Strict. */
export const SESSION_COOKIE = '__Host-uv_console_sid';
/** Between a correct password and its second factor: 5 minutes, and it grants nothing but the verify route. */
export const CHALLENGE_COOKIE = '__Host-uv_console_mfa';
/** Spec 0028 Q10: a random id this console set, to know a browser it has seen; one year. */
export const DEVICE_COOKIE = '__Host-uv_console_dev';

export const IDLE_MS = 15 * 60_000;
export const ABSOLUTE_MS = 8 * 3_600_000;
export const MAX_SESSIONS = 3;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const LOCK_AFTER_FAILURES = 10;
export const LOCK_MS = 15 * 60_000;
export const RECOVERY_CODE_COUNT = 10;
export const UNCONFIRMED_FACTOR_TTL_MS = 15 * 60_000;
export const DEVICE_COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;

// Each written out in full, as the tenant API's are (session.service.ts): every one host-only, Secure, HttpOnly and
// SameSite=Strict (a test reads the header).
const ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; ${ATTRS}; Max-Age=${String(ABSOLUTE_MS / 1000)}`;
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; ${ATTRS}; Max-Age=0`;
export const challengeCookie = (token: string) => `${CHALLENGE_COOKIE}=${token}; ${ATTRS}; Max-Age=${String(CHALLENGE_TTL_MS / 1000)}`;
export const clearedChallengeCookie = () => `${CHALLENGE_COOKIE}=; ${ATTRS}; Max-Age=0`;
export const deviceCookie = (id: string) => `${DEVICE_COOKIE}=${id}; ${ATTRS}; Max-Age=${String(DEVICE_COOKIE_MAX_AGE_SEC)}`;

/** A cookie's value from the header, only in the shape this console issues (43 base64url characters). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [n, ...rest] = part.trim().split('=');
    if (n === name) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}
