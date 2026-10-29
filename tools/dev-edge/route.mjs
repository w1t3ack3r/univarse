// Spec 0027 P3, P9: where the dev edge sends a request, as the stack's Caddy does. The console's host goes to the
// platform API for /api/platform/* and to the console app for everything else; a tenant host never reaches the
// platform API (`/api/platform` is refused at the edge, and again by the tenant API).
const isConsoleHost = (host) => (host ?? '').toLowerCase().split(':')[0].split('.')[0] === 'console';
const isPlatformPath = (path) => {
  const p = (path ?? '/').split('?')[0].toLowerCase();
  return p === '/api/platform' || p.startsWith('/api/platform/');
};

/** 'platform-api' | 'console' | 'api' | 'web' | 'refuse' */
export function route(host, path) {
  if (isConsoleHost(host)) return isPlatformPath(path) ? 'platform-api' : 'console';
  if (isPlatformPath(path)) return 'refuse';
  const p = path ?? '/';
  return p.startsWith('/api/') || p.startsWith('/health/') ? 'api' : 'web';
}
