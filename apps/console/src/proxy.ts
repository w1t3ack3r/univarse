// Runs before every console page (spec 0027 P6): the CSP with a per-request nonce, stricter than the tenant app's.
// The console's browser code talks to its own host only: no storage origin, no third party.
import { NextResponse, type NextRequest } from 'next/server';

/**
 * The console's session cookie, reserved now and set from S2 (spec 0026 T-B, T23): `__Host-` (Secure, host-only, path
 * `/`), HttpOnly, and `SameSite=Strict`, unlike the tenant apps' `Lax`: nobody needs to arrive at the console signed in
 * from another site's link.
 */
export const CONSOLE_SESSION_COOKIE = Object.freeze({ name: '__Host-uv_console_sid', sameSite: 'strict', httpOnly: true, secure: true, path: '/' } as const);

export function csp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic': only nonce'd scripts and what they load. Dev needs eval for fast refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = csp(nonce, process.env.NODE_ENV !== 'production');
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('content-security-policy', policy);
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.headers.set('cache-control', 'no-store');
  // The console is never indexed, wherever it's reachable from.
  res.headers.set('x-robots-tag', 'noindex, nofollow');
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|brand/|favicon.ico).*)' }],
};
