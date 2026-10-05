// What the /auth/me answer means for a page (spec 0005 W7). Pure and client-safe: the error boundary
// imports the digest parser, so nothing here may touch next/headers or the server API.

export interface Me {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly mfa: boolean;
  readonly restricted: boolean;
  readonly permissions: readonly string[];
}

/** The parts of a server-side API answer the check needs; `unreachable` when no answer came at all. */
export type MeAnswer =
  | { readonly status: number; readonly body: unknown; readonly requestId: string | undefined }
  | 'unreachable';

export type SessionCheck =
  | { readonly kind: 'signed-in'; readonly me: Me }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable'; readonly code: string; readonly requestId: string | undefined };

/**
 * Only 401 means "not signed in" (docs/06 §4). Anything else that isn't a usable 200 — a 5xx, a 429,
 * an unreachable API — says nothing about the session, so it must not look like a sign-out.
 */
export function checkSession(answer: MeAnswer): SessionCheck {
  if (answer === 'unreachable') return { kind: 'unavailable', code: 'network.unreachable', requestId: undefined };
  const problem = (answer.body ?? {}) as { code?: unknown; requestId?: unknown };
  const requestId = safeRequestId(problem.requestId) ?? answer.requestId;
  if (answer.status === 401) return { kind: 'signed-out' };
  if (answer.status === 200 && isMe(answer.body)) return { kind: 'signed-in', me: answer.body };
  const code = typeof problem.code === 'string' && SAFE_CODE.test(problem.code) ? problem.code : 'server.internal';
  return { kind: 'unavailable', code, requestId };
}

function isMe(body: unknown): body is Me {
  const b = body as Partial<Me> | null;
  return typeof b === 'object' && b !== null && typeof b.id === 'string' && Array.isArray(b.permissions);
}

// Same shape the API accepts for a request id (apps/api fastify-hooks.ts); problem codes are dotted snake_case.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const safeRequestId = (v: unknown) => (typeof v === 'string' && SAFE_REQUEST_ID.test(v) ? v : undefined);

/*
 * Carrying the problem to the error boundary. In production Next.js replaces a Server Component error's
 * message before it reaches the browser and keeps only `digest`, and it respects a digest the error
 * already has. So the code and support reference travel there — both safe to show, nothing personal.
 */
const DIGEST_PREFIX = 'uv-problem';

export class ApiUnavailableError extends Error {
  readonly digest: string;
  constructor(
    readonly code: string,
    readonly requestId: string | undefined,
  ) {
    super(`API unavailable: ${code}${requestId ? ` (request ${requestId})` : ''}`);
    this.name = 'ApiUnavailableError';
    this.digest = [DIGEST_PREFIX, code, requestId ?? ''].join(':');
  }
}

/** The problem behind a boundary's error, or a generic one when the digest isn't ours (any other crash). */
export function problemFromDigest(digest: string | undefined): { code: string; requestId: string | undefined } {
  const [prefix, code, requestId] = (digest ?? '').split(':');
  if (prefix !== DIGEST_PREFIX || !code || !SAFE_CODE.test(code)) return { code: 'server.internal', requestId: undefined };
  return { code, requestId: safeRequestId(requestId) };
}
