// Browser calls to the API: same origin through the edge, session in the HttpOnly cookie only (spec 0005 W2).
// Nothing auth-related is ever written to localStorage/sessionStorage.
import { messageFor } from '@univarse/contracts';

export interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A problem+json response, mapped to a user message by its code (never by `detail`). */
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

export async function api<T = undefined>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network.offline', undefined);
  }
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const p = (json ?? {}) as { code?: string; requestId?: string; errors?: FieldError[] };
    throw new ApiError(res.status, p.code, p.requestId, p.errors ?? []);
  }
  return json as T;
}
