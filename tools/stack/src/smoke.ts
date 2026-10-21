// Spec 0019 LS6 (and LS1, LS7 at run time): after every deploy, through the edge by Host name:
//   • over HTTPS on 127.0.0.1:443, the certificate verified against the edge CA for that name (never unverified):
//     API health, a tenant request answered for its tenant, the web app's /login;
//   • HSTS exactly once, `max-age=63072000; includeSubDomains`, on a page and an API answer (B1); /login carries a
//     nonce CSP; plain HTTP on 127.0.0.1:80 redirects (308) to the same URL over HTTPS;
//   • the worker started, and its relay published the smoke's own test invalidation (LS6);
//   • the API's and worker's stdout is JSON lines only;
//   • LS1, inspected on the running containers: only Caddy publishes ports (127.0.0.1), the API/worker/web have no
//     route to the database network, every UniVarse container is read-only, non-root, capability-free, limited.
// Returns problems (empty: passed). Prints nothing secret: responses and log lines are only matched, not shown.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { edgeDir } from './certs.js';
import { PROJECT, STACK_DOMAIN } from './config.js';
import { docker } from './docker.js';
import { loadSecrets } from './secrets.js';

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  /** Header lines as sent, so a repeated header is visible (Node joins repeats in `headers`). */
  raw: string[];
}

const collect = (resolve: (r: Res) => void) => (res: IncomingMessage) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => (body += c));
  res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers, raw: res.rawHeaders }));
};

/** GET over HTTPS through the edge, verified against the edge CA for `host` (SNI and the name check). */
export function get(host: string, path: string): Promise<Res> {
  const ca = readFileSync(join(edgeDir(), 'edge-ca.crt'));
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: 443, servername: host, ca, path, method: 'GET', headers: { host }, timeout: 10_000 }, collect(resolve));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** GET over plain HTTP through the edge: only ever a redirect. */
export function getPlain(host: string, path: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: 80, path, method: 'GET', headers: { host }, timeout: 10_000 }, collect(resolve));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

export const HSTS = 'max-age=63072000; includeSubDomains';
/** B1: exactly one HSTS header, exactly this value (no preload, no second header from upstream). */
export function hstsProblems(raw: readonly string[]): string[] {
  // rawHeaders alternates name, value.
  const found = raw.flatMap((v, i) => (i % 2 === 1 && raw[i - 1]?.toLowerCase() === 'strict-transport-security' ? [v] : []));
  if (found.length === 0) return ['no HSTS header'];
  if (found.length > 1) return [`${String(found.length)} HSTS headers (${found.join(' | ')})`];
  return found[0] === HSTS ? [] : [`HSTS is "${found[0] ?? ''}", not "${HSTS}"`];
}

const container = (service: string) => `${PROJECT}-${service}-1`;
const logsOf = (service: string, since?: string) => docker(['logs', ...(since ? ['--since', since] : []), container(service)], { allowFail: true });

/**
 * LS6's test invalidation: a tenant_domain row inserted and deleted at once (a reserved `.invalid` name that never
 * resolves), as the superuser inside the PostgreSQL container. Both changes are captured (spec 0016), so the relay
 * has something to publish even when the seed's own invalidations were relayed by an earlier deploy.
 */
function testInvalidation(): void {
  const host = `smoke-${randomBytes(6).toString('hex')}.invalid`;
  const sql = `INSERT INTO tenant_domain (tenant_id, hostname, kind) SELECT id, '${host}', 'CUSTOM' FROM tenant WHERE slug = 'demo-uni'; DELETE FROM tenant_domain WHERE hostname = '${host}';`;
  docker(['exec', '-e', 'PGPASSWORD', container('postgres'), 'psql', '-U', 'postgres', '-d', 'univarse_platform', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { env: { PGPASSWORD: loadSecrets().postgresSuperuser } });
}

/** Each non-empty stdout line parses as a JSON object. */
export const jsonLinesOnly = (text: string): boolean =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .every((l) => {
      try {
        return typeof JSON.parse(l) === 'object';
      } catch {
        return false;
      }
    });

interface Inspect {
  Name: string;
  HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[] | null; CapAdd: string[] | null; SecurityOpt: string[] | null; Memory: number; PortBindings: Record<string, { HostIp: string }[]> | null };
  Config: { User: string };
  NetworkSettings: { Networks: Record<string, unknown> };
}

/** LS1 at run time, from `docker inspect` of the running stack. */
export function inspectProblems(all: readonly Inspect[]): string[] {
  const problems: string[] = [];
  const byService = (s: string) => all.find((c) => c.Name === `/${container(s)}`);
  for (const c of all) {
    const name = c.Name.slice(1);
    const ports = Object.values(c.HostConfig.PortBindings ?? {}).flat();
    if (ports.length && name !== container('caddy')) problems.push(`${name} publishes a port`);
    for (const p of ports) if (p.HostIp !== '127.0.0.1') problems.push(`${name} publishes on ${p.HostIp || '0.0.0.0'}`);
    if (!c.HostConfig.ReadonlyRootfs && name !== container('clamav')) problems.push(`${name}: root filesystem is writable`);
    if (!(c.HostConfig.CapDrop ?? []).includes('ALL')) problems.push(`${name}: capabilities not dropped`);
    const added = (c.HostConfig.CapAdd ?? []).filter((cap) => !(name === container('caddy') && /^(CAP_)?NET_BIND_SERVICE$/.test(cap)));
    if (added.length) problems.push(`${name}: capabilities added (${added.join(', ')})`);
    if (!(c.HostConfig.SecurityOpt ?? []).some((o) => o.startsWith('no-new-privileges'))) problems.push(`${name}: no-new-privileges not set`);
    if (!c.HostConfig.Memory) problems.push(`${name}: no memory limit`);
  }
  for (const s of ['api', 'worker', 'web']) {
    const c = byService(s);
    if (!c) {
      problems.push(`${s} is not running`);
      continue;
    }
    if (Object.keys(c.NetworkSettings.Networks).some((n) => n.endsWith('_db'))) problems.push(`${s} can reach the database network`);
    if (c.Config.User === '' || c.Config.User.startsWith('0')) problems.push(`${s} runs as root`);
  }
  if (!byService('caddy')) problems.push('caddy is not running');
  return problems;
}

/** The requests and the worker's first pass: they settle shortly after `up --wait` returns (the worker has no healthcheck). */
async function probe(since: string): Promise<string[]> {
  const problems: string[] = [];
  const tenant = `demo-uni.${STACK_DOMAIN}`;
  const check = async (what: string, host: string, path: string, ok: (r: Res) => boolean) => {
    try {
      const r = await get(host, path);
      if (!ok(r)) problems.push(`${what}: HTTP ${String(r.status)}`);
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
    }
  };
  await check('API health', tenant, '/health/live', (r) => r.status === 200);
  await check('tenant request', tenant, '/api/v1/tenant/public-profile', (r) => r.status === 200 && r.body.includes('demo-uni'));
  // A 200 alone isn't enough: an unresolved tenant renders "couldn't find this institution" with status 200.
  await check('web /login names the institution', tenant, '/login', (r) => r.status === 200 && r.body.includes('Demo University') && !r.body.includes('find this institution'));
  // LS7 (B1): HSTS once on a page and on an API answer (the API sends its own value; the edge replaces it).
  for (const [what, path] of [['the login page', '/login'], ['an API answer', '/api/v1/tenant/public-profile']] as const) {
    try {
      const r = await get(tenant, path);
      for (const p of hstsProblems(r.raw)) problems.push(`${what}: ${p}`);
      if (path === '/login' && !/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/.test(String(r.headers['content-security-policy'] ?? ''))) problems.push('the login page has no nonce CSP');
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
    }
  }
  try {
    const r = await getPlain(tenant, '/login?x=1');
    if (r.status !== 308 || r.headers.location !== `https://${tenant}/login?x=1`) problems.push(`plain HTTP: ${String(r.status)} to ${String(r.headers.location)}, not a 308 to the same URL over HTTPS`);
  } catch (e) {
    problems.push(`plain HTTP: ${(e as Error).message}`);
  }
  const worker = logsOf('worker');
  if (!worker.stdout.includes('"event":"worker.started"')) problems.push('the worker did not log worker.started');
  if (!logsOf('worker', since).stdout.includes('"event":"cache.invalidation.relayed"')) problems.push("the worker's relay did not publish the smoke's test invalidation");
  return problems;
}

const SETTLE_MS = 90_000;

export async function smoke(): Promise<string[]> {
  // Retried until it passes or SETTLE_MS is up; the last attempt's problems are the report.
  const deadline = Date.now() + SETTLE_MS;
  const since = new Date().toISOString();
  testInvalidation();
  let problems = await probe(since);
  while (problems.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    problems = await probe(since);
  }
  for (const s of ['api', 'worker']) if (!jsonLinesOnly(logsOf(s).stdout)) problems.push(`${s}: stdout is not JSON lines only`);

  const ids = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim().split('\n').filter(Boolean);
  if (ids.length) problems.push(...inspectProblems(JSON.parse(docker(['inspect', ...ids]).stdout) as Inspect[]));
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await smoke();
  if (problems.length) {
    for (const p of problems) console.error(`[stack:smoke] FAIL ${p}`);
    process.exit(1);
  }
  console.log('[stack:smoke] PASS: HTTPS (verified), the redirect and HSTS, health, tenant, /login, worker and relay, JSON logs, and the hardened shape (LS1, LS6, LS7)');
}
