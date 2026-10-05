// Server-side calls to the API (Server Components, spec 0005 W2/W6). Never imported by client code.
// The request reached us through the edge, which set Host and appended X-Forwarded-For. We pass those
// on, so the API resolves the same tenant and client IP and sees the user's own session cookie.
import { headers } from 'next/headers';

const API = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8099';

export interface ServerApiResult<T> {
  readonly status: number;
  readonly body: T | null;
}

export async function serverApi<T>(path: string): Promise<ServerApiResult<T>> {
  if (!path.startsWith('/api/')) throw new Error('serverApi only calls /api/ paths');
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

  const res = await fetch(`${API}${path}`, { headers: forwarded, cache: 'no-store', redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
}
