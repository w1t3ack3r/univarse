// Server-side calls to the API (Server Components, spec 0005 W2/W6). Never imported by client code.
// The request reached us through the edge, which set Host and appended X-Forwarded-For. We pass those
// on, so the API resolves the same tenant and client IP and sees the user's own session cookie.
import { answer, createApi, type Answer, type Api } from '@univarse/api-client';
import { headers } from 'next/headers';

const API = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8099';

/** The headers that make the API see the user's own request: tenant Host, client IP, cookie, user agent. */
async function forwardedHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const host = incoming.get('host') ?? '';
  const forwarded: Record<string, string> = {
    accept: 'application/json',
    'x-forwarded-host': host,
    'x-forwarded-proto': incoming.get('x-forwarded-proto') ?? 'http',
  };
  const xff = incoming.get('x-forwarded-for');
  if (xff) forwarded['x-forwarded-for'] = xff;
  const cookie = incoming.get('cookie');
  if (cookie) forwarded.cookie = cookie;
  const ua = incoming.get('user-agent');
  if (ua) forwarded['user-agent'] = ua;
  return forwarded;
}

/**
 * The generated client for Server Components (spec 0011 OA8): GET only, so no CSRF surface, with the
 * user's own request forwarded. Use with `answer()` for status, body and request id.
 */
export async function serverClient(): Promise<Pick<Api, 'GET'>> {
  const forwarded = await forwardedHeaders();
  return createApi({
    baseUrl: API,
    fetch: (input, init) => {
      const req = new Request(input, init);
      for (const [k, v] of Object.entries(forwarded)) req.headers.set(k, v);
      return fetch(req, { cache: 'no-store', redirect: 'manual' });
    },
  });
}

/**
 * One server-side GET through the generated client, as status/body/request id (the session check and
 * pages need the status, and a non-JSON answer keeps its status with a null body). No answer at all
 * throws, so the caller decides what it means.
 */
export async function serverGet<D>(call: (api: Pick<Api, 'GET'>) => Promise<{ data?: D; error?: unknown; response: Response }>): Promise<Answer<D>> {
  return answer(call(await serverClient()));
}
