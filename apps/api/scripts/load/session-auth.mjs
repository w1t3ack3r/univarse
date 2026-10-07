// Load test: concurrency of authenticated requests against ONE shard (docs/07 §2 "Connection pool", docs/10 §4.1).
//
// Every authenticated request authenticates its session in a tenant transaction (SessionService.authenticate) and
// then reads in another. This drives authenticated GET /api/v1/files for two tenants on univarse_pool_01, in
// closed-loop steps of rising concurrency, and reports per step: throughput, latency, status codes, and how many
// requests the API shed for want of a connection (`unavailable`: log lines with event db.connection_unavailable,
// ADR-026, or, before ADR-026, an unhandled P2028).
//
// Usage (API compiled and running, its stdout redirected to a file):
//   node --enable-source-maps --import ./dist/otel.js dist/main.js > api.log    # or without --import: no tracing
//   node scripts/load/session-auth.mjs --log api.log --steps 8,16,32,64 --seconds 10
//
// It creates its own users and sessions (no passwords, no login), and deletes them afterwards.
// Local and test databases only: it refuses to run with NODE_ENV=production.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { parseArgs } from 'node:util';
import { createPlatformClient, createTenantShardClient, forTenant } from '@univarse/db';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:8080' },
    steps: { type: 'string', default: '4,8,12,16,24,32,48,64,96,128' },
    seconds: { type: 'string', default: '10' },
    users: { type: 'string', default: '8' },
    log: { type: 'string' },
    path: { type: 'string', default: '/api/v1/files' },
  },
});
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run a load test with NODE_ENV=production');
const rootEnv = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const HOSTS = { 'demo-uni': 'demo-uni.univarse.localhost', 'test-poly': 'test-poly.univarse.localhost' };
const base = new URL(args.base);
const steps = args.steps.split(',').map(Number);
const seconds = Number(args.seconds);
const usersPerTenant = Number(args.users);

const platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL);
const shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL);
const created = [];

async function makeSessions(slug) {
  const tenant = await platform.tenant.findUniqueOrThrow({ where: { slug } });
  const db = forTenant(shard, tenant.id);
  const role = await db.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'STUDENT' } } });
  const out = [];
  for (let i = 0; i < usersPerTenant; i++) {
    const user = await db.userAccount.create({
      data: { tenantId: tenant.id, username: `LOAD-${randomBytes(4).toString('hex').toUpperCase()}`, email: null, displayName: 'Load Test', status: 'ACTIVE' },
    });
    created.push({ tenantId: tenant.id, userId: user.id });
    await db.roleAssignment.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION' } });
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.session.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: new Uint8Array(createHash('sha256').update(token).digest()),
        idleExpiresAt: new Date(now + 3_600_000),
        absoluteExpiresAt: new Date(now + 3_600_000),
        ip: '127.0.0.1',
        userAgent: 'univarse-load',
      },
    });
    out.push({ host: HOSTS[slug], cookie: `__Host-uv_sid=${token}` });
  }
  return out;
}

const SHED = /"event":"db\.connection_unavailable"|"errorCode":"P2028"/;
const shedCount = () => (args.log && existsSync(args.log) ? readFileSync(args.log, 'utf8').split('\n').filter((l) => SHED.test(l)).length : null);

function once(agent, who) {
  const started = performance.now();
  return new Promise((resolve) => {
    const req = request(
      { agent, host: base.hostname, port: base.port, path: args.path, method: 'GET', headers: { host: who.host, cookie: who.cookie } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - started }));
      },
    );
    req.on('error', () => resolve({ status: 'error', ms: performance.now() - started }));
    req.end();
  });
}

async function step(concurrency, sessions) {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const before = shedCount();
  const latencies = [];
  const statuses = {};
  const deadline = performance.now() + seconds * 1000;
  // Closed loop: each virtual user sends its next request as soon as the previous one answers.
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const who = sessions[i % sessions.length];
      while (performance.now() < deadline) {
        const r = await once(agent, who);
        latencies.push(r.ms);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    }),
  );
  agent.destroy();
  await new Promise((r) => setTimeout(r, 300)); // let the API flush its log lines
  latencies.sort((a, b) => a - b);
  const pct = (p) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);
  const after = shedCount();
  return {
    concurrency,
    requests: latencies.length,
    rps: Math.round(latencies.length / seconds),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: Math.round(latencies.at(-1)),
    statuses,
    unavailable: before === null ? 'n/a' : after - before,
  };
}

try {
  const demo = await makeSessions('demo-uni');
  const poly = await makeSessions('test-poly');
  // Interleave tenants, so each step is half demo-uni, half test-poly, on the same shard.
  const sessions = demo.flatMap((d, i) => [d, poly[i]]);
  await step(4, sessions); // warm-up, not reported
  const results = [];
  for (const c of steps) {
    const r = await step(c, sessions);
    results.push(r);
    console.log(JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 1_000));
  }
  console.table(results.map(({ statuses, ...r }) => ({ ...r, statuses: JSON.stringify(statuses) })));
} finally {
  for (const c of created) await forTenant(shard, c.tenantId).userAccount.deleteMany({ where: { id: c.userId } });
  await shard.$disconnect();
  await platform.$disconnect();
}
