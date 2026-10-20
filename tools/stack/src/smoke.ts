// Spec 0019 LS6 (and LS1 at run time): after every deploy, through the edge on 127.0.0.1:80 by Host header:
//   • API health, a tenant request answered for its tenant, the web app's /login;
//   • the worker started, and its relay published (the seed's invalidations);
//   • the API's and worker's stdout is JSON lines only;
//   • LS1, inspected on the running containers: only Caddy publishes ports (127.0.0.1), the API/worker/web have no
//     route to the database network, every UniVarse container is read-only, non-root, capability-free, limited.
// Returns problems (empty: passed). Prints nothing secret: responses and log lines are only matched, not shown.
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { PROJECT, STACK_DOMAIN } from './config.js';
import { docker } from './docker.js';

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export function get(host: string, path: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 80, path, method: 'GET', headers: { host }, timeout: 10_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

const container = (service: string) => `${PROJECT}-${service}-1`;
const logsOf = (service: string) => docker(['logs', container(service)], { allowFail: true });

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
async function probe(): Promise<string[]> {
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
  const worker = logsOf('worker');
  if (!worker.stdout.includes('"event":"worker.started"')) problems.push('the worker did not log worker.started');
  if (!worker.stdout.includes('"event":"cache.invalidation.relayed"')) problems.push('the worker\'s relay published nothing (the seed leaves invalidations to relay)');
  return problems;
}

const SETTLE_MS = 90_000;

export async function smoke(): Promise<string[]> {
  // Retried until it passes or SETTLE_MS is up; the last attempt's problems are the report.
  const deadline = Date.now() + SETTLE_MS;
  let problems = await probe();
  while (problems.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    problems = await probe();
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
  console.log('[stack:smoke] PASS: health, tenant, /login, worker and relay, JSON logs, and the hardened shape (LS1, LS6)');
}
