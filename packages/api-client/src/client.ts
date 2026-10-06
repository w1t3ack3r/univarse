// Spec 0011 OA8: the one way the web app calls the API. `paths` is generated from openapi.json; this
// file adds the behaviour every call shares, so no call site re-implements it:
// - network failures and non-JSON answers (a proxy's 502 page) become typed ApiErrors with the
//   support reference from `x-request-id`;
// - 204 and empty bodies are never parsed; binary downloads are links (`contentUrl`), not fetches;
// - Problem Details become ApiError(status, code, requestId, fieldErrors), the message chosen by code.
// Cookies ride on the browser (`credentials: 'same-origin'`) or on the server transport's forwarding;
// CSRF is satisfied by same-origin Sec-Fetch-Site, and the server transport is GET-only.
import { messageFor } from '@univarse/contracts';
import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths } from './schema.js';
export type Api = Client<paths>;

type Method = 'get' | 'post' | 'put' | 'delete';
type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : never;
/** The JSON success body of one operation, e.g. `ResponseBody<'/api/v1/files/{id}', 'get'>`. */
export type ResponseBody<P extends keyof paths, M extends Method & keyof paths[P]> = paths[P][M] extends {
  responses: infer R;
}
  ? JsonOf<R[200 & keyof R]> | JsonOf<R[201 & keyof R]> | JsonOf<R[202 & keyof R]>
  : never;

export interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A failed call, mapped to a user message by its code (never by `detail`). */
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

const JSON_TYPE = /^application\/(problem\+)?json(;|$)/i;
const requestIdOf = (res: Response) => res.headers.get('x-request-id') ?? undefined;
const isEmpty = (res: Response) => res.status === 204 || res.headers.get('content-length') === '0';

/**
 * Wraps fetch: no answer at all is `network.offline`; an answer that isn't the JSON the API always
 * sends (an HTML error page, a truncated body) is `server.unexpected_response` with its status and
 * support reference. 204/empty answers pass through unparsed.
 */
export function guardedFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    let res: Response;
    try {
      res = await base(input, init);
    } catch {
      throw new ApiError(0, 'network.offline', undefined);
    }
    if (isEmpty(res)) return res;
    const unexpected = () => new ApiError(res.status, 'server.unexpected_response', requestIdOf(res));
    if (!JSON_TYPE.test(res.headers.get('content-type') ?? '')) throw unexpected();
    try {
      JSON.parse(await res.clone().text());
    } catch {
      throw unexpected();
    }
    return res;
  };
}

export interface ApiOptions {
  /** '' in the browser (same origin, through the edge); the API's internal URL on the server. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly credentials?: 'same-origin' | 'include' | 'omit';
}

export function createApi(opts: ApiOptions): Api {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: guardedFetch(opts.fetch ?? ((input, init) => globalThis.fetch(input, init))),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    headers: { accept: 'application/json' },
  });
}

/** The data of a successful call; anything else throws an ApiError (browser components). */
export async function unwrap<D>(call: Promise<{ data?: D; error?: unknown; response: Response }>): Promise<D> {
  let r: { data?: D; error?: unknown; response: Response };
  try {
    r = await call;
  } catch (err) {
    throw err instanceof ApiError ? err : new ApiError(0, 'server.unexpected_response', undefined);
  }
  if (r.response.ok) return r.data as D;
  const p = (r.error ?? {}) as { code?: unknown; requestId?: unknown; errors?: unknown };
  throw new ApiError(
    r.response.status,
    typeof p.code === 'string' ? p.code : undefined,
    typeof p.requestId === 'string' ? p.requestId : requestIdOf(r.response),
    Array.isArray(p.errors) ? (p.errors as FieldError[]) : [],
  );
}

export interface Answer<D> {
  readonly status: number;
  /** The success body, the Problem body, or null when the answer wasn't the API's JSON. */
  readonly body: D | Record<string, unknown> | null;
  readonly data: D | undefined;
  readonly requestId: string | undefined;
}

/**
 * Server Components: the status and body without throwing for HTTP outcomes, as the session check and
 * pages need (spec 0005 W7). A non-JSON answer keeps its status with a null body; no answer at all
 * (network) still throws, so the caller decides what it means.
 */
export async function answer<D>(call: Promise<{ data?: D; error?: unknown; response: Response }>): Promise<Answer<D>> {
  try {
    const r = await call;
    const body = r.response.ok ? (r.data ?? null) : ((r.error ?? null) as Record<string, unknown> | null);
    return { status: r.response.status, body, data: r.response.ok ? r.data : undefined, requestId: requestIdOf(r.response) };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'server.unexpected_response') return { status: err.status, body: null, data: undefined, requestId: err.requestId };
    throw err;
  }
}

// Compile-time check: the download route is in the generated document.
const DOWNLOAD: keyof paths = '/api/v1/files/{id}/content';

/** The binary download's URL, for an `<a href download>`: the browser streams it, nothing is parsed. */
export const contentUrl = (id: string): string => DOWNLOAD.replace('{id}', encodeURIComponent(id));

