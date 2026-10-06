// Runs before every page (spec 0005 W7/W8):
// - CSP with a per-request nonce; Next applies the nonce to its own scripts. No third-party origins.
// - Workspace pages without a session cookie redirect to login before anything renders. The real check
//   is the API (requireSession); this only avoids rendering a shell for a guest.
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = '__Host-uv_sid';

/**
 * The one extra origin the browser may talk to: object storage, for presigned uploads (spec 0010 D1).
 * Only a bare `scheme://host[:port]` is accepted, so configuration can't smuggle in other directives.
 */
export function uploadOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  return /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(raw.trim()) ? raw.trim() : null;
}

export function csp(nonce: string, dev: boolean, upload: string | null = null): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic': only nonce'd scripts and what they load. Dev needs eval for fast refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // <style> elements need the nonce (dev injects un-nonced ones). Style *attributes* can't carry a nonce
    // and Next sets some (route announcer); allowing attributes only cannot run script (CSP3 style-src-attr).
    `style-src 'self'${dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${upload ? ` ${upload}` : ''}${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith('/workspace') && !req.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const nonce = btoa(crypto.randomUUID());
  const policy = csp(nonce, process.env.NODE_ENV !== 'production', uploadOrigin(process.env.STORAGE_UPLOAD_ORIGIN ?? 'http://127.0.0.1:8333'));
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('content-security-policy', policy);
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|brand/|favicon.ico).*)' }],
};
