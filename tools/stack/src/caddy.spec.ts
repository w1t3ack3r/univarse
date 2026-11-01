// Spec 0027 P3, P4: the edge's walls, read from the Caddyfile as the pinned Caddy itself adapts it (`caddy adapt`, no
// network, no listener). The live proof is the smoke's, after every deploy; this pins the routes. Needs the Docker CLI.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMPOSE_FILE, CONSOLE_HOST, EDGE_GATEWAY, STACK_DOMAIN, THIRD_PARTY } from './config.js';

interface Handler {
  handler: string;
  status_code?: number | string;
  upstreams?: { dial: string }[];
  routes?: Route[];
}
interface Route {
  match?: Record<string, unknown>[];
  handle?: Handler[];
}

let routes: Route[];
beforeAll(() => {
  const dir = join(dirname(COMPOSE_FILE), 'caddy');
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/etc/caddy:ro`, THIRD_PARTY.caddy, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile'], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0) throw new Error(`caddy adapt failed: ${r.stderr}`);
  const servers = (JSON.parse(r.stdout) as { apps: { http: { servers: Record<string, { listen: string[]; routes: Route[] }> } } }).apps.http.servers;
  routes = Object.values(servers).find((s) => s.listen.includes(':8443'))?.routes ?? [];
});

const hostsOf = (r: Route) => (r.match ?? []).flatMap((m) => (m.host as string[] | undefined) ?? []);
/** A site's inner routes, in order: what each matches and what it does (`404`, or the upstream it proxies to). */
function site(host: string): { match: unknown; does: string }[] {
  const outer = routes.find((r) => hostsOf(r).includes(host));
  if (!outer) throw new Error(`no site for ${host}`);
  // Caddy wraps a site in subroutes: the site's own (with the `edge` snippet's headers), then the `route` block's.
  let inner: Route[] = [outer];
  while (inner.length === 1) {
    const sub = (inner[0]?.handle ?? []).find((h) => h.handler === 'subroute');
    if (!sub) break;
    inner = sub.routes ?? [];
  }
  return inner.map((r) => ({
    match: r.match ?? '*',
    does: (r.handle ?? []).map((h) => (h.handler === 'static_response' ? String(h.status_code) : (h.upstreams ?? []).map((u) => u.dial).join())).join(),
  }));
}

describe('[spec 0027 P3, P4] the edge', () => {
  it('[P4] the console\'s site refuses everything but the edge network\'s gateway first, with 404, before either upstream', () => {
    const s = site(CONSOLE_HOST);
    expect(s[0]).toEqual({ match: [{ not: [{ remote_ip: { ranges: [EDGE_GATEWAY] } }] }], does: '404' });
    expect(s.slice(1)).toEqual([
      { match: [{ path: ['/api/platform/*'] }], does: 'platform-api:8081' },
      { match: '*', does: 'console:3001' },
    ]);
  });

  it('[P3] the console\'s own site is matched before the tenants\' wildcard', () => {
    const order = routes.map((r) => hostsOf(r).join());
    expect(order.indexOf(CONSOLE_HOST)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(CONSOLE_HOST)).toBeLessThan(order.indexOf(`*.${STACK_DOMAIN}`));
  });

  it('[P3] a tenant host refuses /api/platform first, and nothing on it reaches the platform API', () => {
    const s = site(`*.${STACK_DOMAIN}`);
    expect(s[0]).toEqual({ match: [{ path: ['/api/platform', '/api/platform/*'] }], does: '404' });
    expect(s.map((r) => r.does)).not.toContain('platform-api:8081');
    for (const r of routes) if (!hostsOf(r).includes(CONSOLE_HOST)) expect(JSON.stringify(r)).not.toContain('platform-api');
  });
});
