// The console's calls to the platform API (spec 0028): from the browser, same origin through the edge, so the
// platform API's allowlist sees the staff member's own address (spec 0027 P4). The session is the HttpOnly cookie
// only; nothing is ever written to localStorage or sessionStorage. Failures arrive as ApiError, with the message the
// problem code maps to (never the API's own `detail`) and the support reference.
import { messageFor } from '@univarse/contracts';

export interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
    readonly fieldErrors: readonly FieldError[] = [],
  ) {
    super(messageFor(code));
    this.name = 'ApiError';
  }
}

const BASE = '/api/platform/v1';

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { ifMatch?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.ifMatch ? { 'if-match': opts.ifMatch } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network.offline', undefined);
  }
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (json ?? {}) as { code?: unknown; requestId?: unknown; errors?: unknown };
    throw new ApiError(
      res.status,
      typeof p.code === 'string' ? p.code : undefined,
      typeof p.requestId === 'string' ? p.requestId : requestId,
      Array.isArray(p.errors) ? (p.errors as FieldError[]) : [],
    );
  }
  return json as T;
}

/** Any error as an ApiError, for display. */
export const asApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError(0, undefined, undefined);

/** A form's text field, trimmed. */
export const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** A password exactly as typed: never trimmed. */
export const secretField = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};
