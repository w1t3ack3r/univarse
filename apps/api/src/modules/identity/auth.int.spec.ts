/**
 * Auth slice: activation → login → authenticated endpoint → logout, plus expiry, revocation,
 * rate limits, lockout, CSRF, permissions and tenant membership.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running (`pnpm dev:infra`).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import type { Mailer, OutboundEmail } from '../../shared/infra/mailer.js';
import { enrolTestTotp, totpCode } from '../../testing/mfa-helpers.js';
import { hashPassword } from './password.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const DEMO = 'demo-uni.univarse.localhost';
const POLY = 'test-poly.univarse.localhost';
const PASSWORD = 'Correct-Horse-Battery-9';
const run = randomBytes(3).toString('hex').toUpperCase(); // unique usernames per run

const outbox: OutboundEmail[] = [];
const captureMailer: Mailer = {
  send: (m) => {
    outbox.push(m);
    return Promise.resolve();
  },
};

let app: NestFastifyApplication;
let shard: TenantShardClient;
const tenants: { demo: string; poly: string; [slug: string]: string } = { demo: '', poly: '' };
let platform: PlatformClient;
let appBehindEdge: NestFastifyApplication; // TRUSTED_PROXIES=127.0.0.1
const created: { tenantId: string; userId: string }[] = [];

const randomIp = () => `10.${randomInt(255)}.${randomInt(255)}.${randomInt(1, 255)}`;

type Opts = { cookie?: string; ip?: string; headers?: Record<string, string>; body?: unknown };
async function call(method: 'GET' | 'POST', host: string, url: string, o: Opts = {}) {
  return app.getHttpAdapter().getInstance().inject({
    method,
    url,
    // Fresh IP per call so persisted Valkey counters from earlier runs can't leak between tests.
    remoteAddress: o.ip ?? randomIp(),
    headers: {
      host,
      ...(method === 'POST' ? { 'sec-fetch-site': 'same-origin' } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
}

const cookieFrom = (setCookie: string | string[] | undefined) => {
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(';')[0]!;
};

async function makeUser(
  tenant: string,
  opts: { role: string; username?: string; active?: boolean; validTo?: Date },
): Promise<{ id: string; username: string }> {
  const tenantId = tenants[tenant];
  if (!tenantId) throw new Error(`Unknown test tenant ${tenant}`);
  const db = forTenant(shard, tenantId);
  const username = opts.username ?? `T${run}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const user = await db.userAccount.create({
    data: {
      tenantId,
      username,
      email: `${username.toLowerCase()}@test.local`,
      displayName: 'Test User',
      status: opts.active === false ? 'PENDING_ACTIVATION' : 'ACTIVE',
      passwordHash: opts.active === false ? null : await hashPassword(PASSWORD),
    },
  });
  const role = await db.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: opts.role } } });
  await db.roleAssignment.create({
    data: { tenantId, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION', validTo: opts.validTo ?? null },
  });
  created.push({ tenantId, userId: user.id });
  return { id: user.id, username };
}

/** Admins hold privileged permissions ⇒ need MFA (spec 0001 M8). Enrol a factor and complete the challenge. */
async function loginAdminWithMfa(host: string, user: { id: string; username: string }, tenantKey: string = 'demo'): Promise<string> {
  const secret = await enrolTestTotp(shard, tenants[tenantKey]!, user.id);
  const first = await login(host, user.username);
  expect(first.json()).toEqual({ mfaRequired: true });
  const verify = await call('POST', host, '/api/v1/auth/mfa/verify', {
    cookie: cookieFrom(first.headers['set-cookie']),
    body: { code: totpCode(secret) },
  });
  expect(verify.statusCode).toBe(200);
  return cookieFrom(verify.headers['set-cookie']);
}

async function login(host: string, username: string, password = PASSWORD, ip = randomIp()) {
  return call('POST', host, '/api/v1/auth/login', { ip, body: { username, password } });
}

beforeAll(async () => {
  platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
  for (const [k, slug] of [['demo', 'demo-uni'], ['poly', 'test-poly']] as const) {
    tenants[k] = (await platform.tenant.findUniqueOrThrow({ where: { slug } })).id;
  }
  shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }), { mailer: captureMailer });
  appBehindEdge = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', TRUSTED_PROXIES: '127.0.0.1' }), {
    mailer: captureMailer,
  });
});

afterAll(async () => {
  for (const c of created) await forTenant(shard, c.tenantId).userAccount.deleteMany({ where: { id: c.userId } });
  await shard.$disconnect();
  await platform.$disconnect();
  await app.close();
  await appBehindEdge.close();
});

describe('activation', () => {
  it('emails a code to a pending account and answers identically for unknown accounts', async () => {
    const u = await makeUser('demo', { role: 'STUDENT', active: false });
    const before = outbox.length;
    const known = await call('POST', DEMO, '/api/v1/auth/activation/request', { body: { username: u.username } });
    const unknown = await call('POST', DEMO, '/api/v1/auth/activation/request', { body: { username: `NOPE-${run}` } });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(outbox.length).toBe(before + 1);
    expect(outbox.at(-1)!.to).toBe(`${u.username.toLowerCase()}@test.local`);
    expect(outbox.at(-1)!.text).toMatch(/\b\d{6}\b/);
  });

  it('activates with the right code, rejects weak passwords, and codes are single-use', async () => {
    const u = await makeUser('demo', { role: 'STUDENT', active: false });
    await call('POST', DEMO, '/api/v1/auth/activation/request', { body: { username: u.username } });
    const code = /\b(\d{6})\b/.exec(outbox.at(-1)!.text)![1]!;

    const weak = await call('POST', DEMO, '/api/v1/auth/activation/confirm', { body: { username: u.username, code, password: 'password123' } });
    expect(weak.statusCode).toBe(422);
    expect(weak.json().errors.map((e: { code: string }) => e.code)).toContain('too_common');

    const personal = await call('POST', DEMO, '/api/v1/auth/activation/confirm', {
      body: { username: u.username, code, password: `x${u.username}x-long` },
    });
    expect(personal.json().errors.map((e: { code: string }) => e.code)).toContain('contains_personal_info');

    const ok = await call('POST', DEMO, '/api/v1/auth/activation/confirm', { body: { username: u.username, code, password: PASSWORD } });
    expect(ok.statusCode).toBe(204);
    expect((await login(DEMO, u.username)).statusCode).toBe(200);

    const reuse = await call('POST', DEMO, '/api/v1/auth/activation/confirm', { body: { username: u.username, code, password: PASSWORD } });
    expect(reuse.statusCode).toBe(400);
  });

  it('locks a code after 5 wrong attempts, even if the 6th is correct', async () => {
    const u = await makeUser('demo', { role: 'STUDENT', active: false });
    await call('POST', DEMO, '/api/v1/auth/activation/request', { body: { username: u.username } });
    const code = /\b(\d{6})\b/.exec(outbox.at(-1)!.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', DEMO, '/api/v1/auth/activation/confirm', { body: { username: u.username, code: wrong, password: PASSWORD } });
      expect(r.statusCode).toBe(400);
    }
    const right = await call('POST', DEMO, '/api/v1/auth/activation/confirm', { body: { username: u.username, code, password: PASSWORD } });
    expect(right.statusCode).toBe(400);
  });
});

describe('login, session and logout', () => {
  it('sets a hardened session cookie and never returns secrets', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const res = await login(DEMO, u.username);
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-uv_sid=[A-Za-z0-9_-]{43};/);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(setCookie).toContain(attr);
    expect(JSON.stringify(res.json())).not.toMatch(/argon2|passwordHash/);
  });

  it('wrong password and unknown user fail identically', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const wrong = await login(DEMO, u.username, 'not-the-password-123');
    const unknown = await login(DEMO, `GHOST-${run}`);
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json().code).toBe(unknown.json().code);
  });

  it('me requires a session; logout revokes it server-side', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    expect((await call('GET', DEMO, '/api/v1/auth/me')).statusCode).toBe(401);
    const me = await call('GET', DEMO, '/api/v1/auth/me', { cookie });
    expect(me.json()).toMatchObject({ username: u.username, mfa: false });

    const out = await call('POST', DEMO, '/api/v1/auth/logout', { cookie });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    // Replaying the old cookie must fail even though the browser was told to delete it.
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
  });

  it.each([
    ['idle timeout', { idleExpiresAt: new Date(Date.now() - 1000) }],
    ['absolute timeout', { absoluteExpiresAt: new Date(Date.now() - 1000) }],
    ['revocation', { revokedAt: new Date() }],
  ])('rejects a session after %s', async (_label, patch) => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    await forTenant(shard, tenants.demo).session.updateMany({ where: { userId: u.id }, data: patch });
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('a disabled account loses its existing sessions immediately', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    await forTenant(shard, tenants.demo).userAccount.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
  });
});

describe('abuse controls', () => {
  it('rate-limits repeated attempts per IP + username with Retry-After', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const ip = randomIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login(DEMO, u.username, 'wrong-password-xx', ip)).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    const limited = await login(DEMO, u.username, 'wrong-password-xx', ip);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('locks the account after 10 failures from anywhere (distributed guessing)', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    for (let i = 0; i < 10; i++) await login(DEMO, u.username, `wrong-${i}-password`);
    expect((await login(DEMO, u.username)).statusCode).toBe(401); // correct password, but locked
  });
});

describe('tenant membership', () => {
  it("a session from one institution is not valid at another", async () => {
    const admin = await makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const cookie = cookieFrom((await login(DEMO, admin.username)).headers['set-cookie']);
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).statusCode).toBe(200);
    expect((await call('GET', POLY, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
    expect((await call('GET', POLY, '/api/v1/users', { cookie })).statusCode).toBe(401);
  });

  it('the same username in two institutions is two separate accounts', async () => {
    const username = `SHARED-${run}`;
    await makeUser('demo', { role: 'STUDENT', username });
    await makeUser('poly', { role: 'STUDENT', username });
    await forTenant(shard, tenants.poly).userAccount.update({
      where: { tenantId_username: { tenantId: tenants.poly, username } },
      data: { passwordHash: await hashPassword('A-different-poly-password-1') },
    });
    expect((await login(DEMO, username)).statusCode).toBe(200);
    expect((await login(POLY, username)).statusCode).toBe(401);
    expect((await login(POLY, username, 'A-different-poly-password-1')).statusCode).toBe(200);
  });
});

describe('CSRF', () => {
  it.each([
    ['no fetch metadata or origin', {}],
    ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
    ['foreign origin', { origin: 'https://evil.example' }],
  ])('rejects state-changing requests with %s', async (_label, headers) => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: DEMO, ...headers },
      payload: { username: 'X', password: 'Y' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('request.csrf_rejected');
  });

  it('accepts a matching Origin when fetch metadata is absent', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: randomIp(),
      headers: { host: DEMO, origin: `http://${DEMO}` },
      payload: { username: u.username, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('authorization', () => {
  it('a lecturer lacks identity.user.view → 403', async () => {
    const u = await makeUser('demo', { role: 'LECTURER' });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    const res = await call('GET', DEMO, '/api/v1/users', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden');
  });

  it('an institution admin sees only their own institution’s users, without secrets', async () => {
    const admin = await makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const polyUser = await makeUser('poly', { role: 'STUDENT' });
    const cookie = await loginAdminWithMfa(DEMO, admin);
    const res = await call('GET', DEMO, '/api/v1/users', { cookie });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(polyUser.id);
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash|argon2/);
  });

  it('an expired role assignment grants nothing', async () => {
    const u = await makeUser('demo', { role: 'INSTITUTION_ADMIN', validTo: new Date(Date.now() - 60_000) });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    expect((await call('GET', DEMO, '/api/v1/users', { cookie })).statusCode).toBe(403);
  });
});

describe('active membership: already-issued sessions lose access', () => {
  it('removing a role takes effect on the very next request', async () => {
    const admin = await makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const cookie = await loginAdminWithMfa(DEMO, admin);
    expect((await call('GET', DEMO, '/api/v1/users', { cookie })).statusCode).toBe(200);

    await forTenant(shard, tenants.demo).roleAssignment.updateMany({ where: { userId: admin.id }, data: { revokedAt: new Date() } });

    expect((await call('GET', DEMO, '/api/v1/users', { cookie })).statusCode).toBe(403);
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).json().permissions).toEqual([]);
  });

  it('a locked account loses its existing sessions', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await login(DEMO, u.username)).headers['set-cookie']);
    await forTenant(shard, tenants.demo).userAccount.update({ where: { id: u.id }, data: { status: 'LOCKED' } });
    expect((await call('GET', DEMO, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('suspending the institution blocks existing sessions; resuming restores them', async () => {
    // Dedicated tenant so suspending it cannot disturb other tests.
    const pool = await platform.shard.findUniqueOrThrow({ where: { name: 'pool-01' } });
    const slug = `susp-${run.toLowerCase()}`;
    const host = `${slug}.univarse.localhost`;
    const tenant = await platform.tenant.create({
      data: { slug, legalName: 'Suspension Test University', shortName: 'SUSP', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE', shardId: pool.id },
    });
    await platform.tenantDomain.create({ data: { tenantId: tenant.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
    tenants[slug] = tenant.id;
    const db = forTenant(shard, tenant.id);
    await db.role.create({ data: { tenantId: tenant.id, key: 'STUDENT', name: 'Student', isSystem: true, permissions: [] } });
    try {
      const u = await makeUser(slug, { role: 'STUDENT' });
      const cookie = cookieFrom((await login(host, u.username)).headers['set-cookie']);
      expect((await call('GET', host, '/api/v1/auth/me', { cookie })).statusCode).toBe(200);

      // Lifecycle operations call TenantResolver.invalidate() on the instance that performs them;
      // other instances converge within TENANT_CACHE_TTL_MS (docs/02 §7.3).
      await platform.tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
      app.get(TenantResolver).invalidate();
      const blocked = await call('GET', host, '/api/v1/auth/me', { cookie });
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().code).toBe('tenant.suspended');

      await platform.tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE' } });
      app.get(TenantResolver).invalidate();
      expect((await call('GET', host, '/api/v1/auth/me', { cookie })).statusCode).toBe(200);
    } finally {
      await db.userAccount.deleteMany({});
      await db.role.deleteMany({});
      await platform.tenant.delete({ where: { id: tenant.id } });
      created.splice(0, created.length, ...created.filter((c) => c.tenantId !== tenant.id));
      app.get(TenantResolver).invalidate();
    }
  });
});

describe('client IP for rate limiting cannot be forged', () => {
  const attempt = (target: NestFastifyApplication, username: string, remoteAddress: string, xff?: string) =>
    target.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress,
      headers: { host: DEMO, 'sec-fetch-site': 'same-origin', ...(xff ? { 'x-forwarded-for': xff } : {}) },
      payload: { username, password: 'wrong-password-xx' },
    });

  it('without trusted proxies, rotating X-Forwarded-For does not reset the limit', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const ip = randomIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt(app, u.username, ip, randomIp())).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('behind a trusted edge, forged left-most entries are ignored (right-most untrusted address is the client)', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const realClient = randomIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Client forges a different address each time; the edge appends the real one.
      codes.push((await attempt(appBehindEdge, u.username, '127.0.0.1', `${randomIp()}, ${realClient}`)).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('forwarding headers from an untrusted peer are ignored even when proxies are configured', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const peer = randomIp(); // not 127.0.0.1 ⇒ not trusted
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt(appBehindEdge, u.username, peer, randomIp())).statusCode);
    expect(codes.at(-1)).toBe(429);
  });

  it('distinct clients behind the same edge get separate buckets (the edge IP is not the key)', async () => {
    const u = await makeUser('demo', { role: 'STUDENT' });
    const codes: number[] = [];
    // 8 attempts from 8 different real clients: none should be limited by the per IP+user rule.
    for (let i = 0; i < 8; i++) codes.push((await attempt(appBehindEdge, u.username, '127.0.0.1', randomIp())).statusCode);
    expect(codes.every((c) => c === 401)).toBe(true);
  });
});
