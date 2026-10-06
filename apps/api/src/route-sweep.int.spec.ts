/**
 * Spec 0009 — the API route sweep (isolation layer 3). Every AC ID appears in a test name.
 * Tenant A = demo-uni, tenant B = test-poly, both seeded; markers are random per run.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey and Vault running, `pnpm --filter @univarse/api build`
 * (RS8 boots the compiled production build).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreateAppOptions } from './bootstrap.js';
import { loadConfig, type AppConfig } from './config/config.js';
import { hashPassword } from './modules/identity/password.js';
import { base32Decode } from './modules/identity/totp.js';
import { codeIn, createHarness, HOSTS, PASSWORD, randomIp, type Harness, type InjectResult } from './testing/int-harness.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from './testing/mfa-helpers.js';
import { FileScanWorker } from './modules/files/file-scan.worker.js';
import { CONTROL_ROUTES, LEAK_VICTIM, LeakyControlsController } from './testing/route-controls.js';
import { attachConformance } from './testing/conformance.js';
import {
  captureRoutes,
  checkCollection,
  checkResource,
  containsAny,
  crossCheckRoutes,
  nestRoutes,
  type AuthKind,
  type Finding,
  type IsolationClass,
  type RouteKey,
} from './testing/route-sweep.js';

const A = HOSTS.demo;
const B = HOSTS.poly;
const PAUSED = 'paused-uni.univarse.localhost';
const run = randomBytes(3).toString('hex').toUpperCase();
// Random per run: no credential literal in the repo (gitleaks), still meets the password policy.
const pw = (tag: string) => `${tag}-${randomBytes(9).toString('base64url')}-7a`;
const OTHER_PASSWORD = pw('Other');

let h: Harness;
let app: NestFastifyApplication;
let config: AppConfig;
const fastifyRoutes = new Set<RouteKey>();
let nestCount = 0;
const tenant = { A: '', B: '' };
let shardId = '';

// ---------------------------------------------------------------------------------------------------
// HTTP against the sweep app (real guards, filters, CSRF hook, rate limiting by client IP)
// ---------------------------------------------------------------------------------------------------
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Req {
  method: Method;
  host: string;
  url: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}
const send = (r: Req): Promise<InjectResult> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: r.method,
      url: r.url,
      remoteAddress: randomIp(),
      headers: {
        host: r.host,
        ...(r.method !== 'GET' ? { 'sec-fetch-site': 'same-origin' } : {}),
        ...(r.cookie ? { cookie: r.cookie } : {}),
        ...r.headers,
      },
      ...(r.body !== undefined ? { payload: r.body as object } : {}),
    });

const cookies = (res: InjectResult): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
};
const sessionOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20);
const challengeOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_mfa=') && c.length > 20);
const json = (res: InjectResult): Record<string, unknown> => {
  try {
    return res.json() as Record<string, unknown>;
  } catch {
    return {};
  }
};
const db = (t: 'A' | 'B') => forTenant(h.shard, tenant[t]);

// ---------------------------------------------------------------------------------------------------
// Identities (RS9): real users, real MFA, real sessions
// ---------------------------------------------------------------------------------------------------
interface Person {
  id: string;
  username: string;
  email: string;
  host: string;
  t: 'A' | 'B';
  secret?: Buffer;
  session: string;
}

async function user(t: 'A' | 'B', role: string, opts: { username?: string; email?: string; status?: 'ACTIVE' | 'PENDING_ACTIVATION' } = {}) {
  const u = await h.makeUser(t === 'A' ? 'demo' : 'poly', {
    role,
    ...(opts.username ? { username: opts.username } : {}),
    ...(opts.email !== undefined ? { email: opts.email } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  });
  return { ...u, email: u.email ?? '' };
}

/** Password login (+ code when the user has a factor). Returns the session cookie. */
async function signIn(host: string, username: string, password: string, secret?: Buffer, t?: 'A' | 'B', id?: string): Promise<string> {
  const res = await send({ method: 'POST', host, url: '/api/v1/auth/login', body: { username, password } });
  expect(res.statusCode).toBe(200);
  if (!secret) return sessionOf(res)!;
  const v = await send({ method: 'POST', host, url: '/api/v1/auth/mfa/verify', cookie: challengeOf(res)!, body: { code: totpCode(secret) } });
  expect(v.statusCode).toBe(200);
  if (t && id) await resetReplayGuard(h.shard, tenant[t], id);
  return sessionOf(v)!;
}

/** A user of `role` with a TOTP factor (seeded), signed in with password + code. */
async function mfaPerson(t: 'A' | 'B', role: string, opts: { username?: string; email?: string } = {}): Promise<Person> {
  const u = await user(t, role, opts);
  const secret = await enrolTestTotp(h.shard, tenant[t], u.id);
  const host = t === 'A' ? A : B;
  const session = await signIn(host, u.username, PASSWORD, secret, t, u.id);
  return { id: u.id, username: u.username, email: u.email, host, t, secret, session };
}

/** Fresh step-up on the person's session (the cookie rotates). */
async function stepUp(p: Person): Promise<string> {
  const res = await send({ method: 'POST', host: p.host, url: '/api/v1/auth/step-up', cookie: p.session, body: { password: PASSWORD, code: totpCode(p.secret!) } });
  expect(res.statusCode).toBe(200);
  await resetReplayGuard(h.shard, tenant[p.t], p.id);
  p.session = sessionOf(res)!;
  return p.session;
}

/** A privileged user with no factor: the M8 enrolment-only session. */
async function restrictedSession(t: 'A' | 'B' = 'A') {
  const u = await user(t, 'INSTITUTION_ADMIN');
  const res = await send({ method: 'POST', host: t === 'A' ? A : B, url: '/api/v1/auth/login', body: { username: u.username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  expect(json(res)).toMatchObject({ mfaEnrolmentRequired: true });
  return { ...u, session: sessionOf(res)! };
}

// Snapshots of persisted state, without fields that move on every request (last_seen, idle expiry).
async function accountState(t: 'A' | 'B', userId: string) {
  const d = db(t);
  const [u, sessions, factors, codes] = await Promise.all([
    d.userAccount.findUnique({ where: { id: userId }, select: { id: true, username: true, email: true, status: true, passwordHash: true } }),
    d.session.findMany({ where: { userId }, select: { id: true, restricted: true, mfaAt: true, stepUpAt: true, revokedAt: true }, orderBy: { id: 'asc' } }),
    d.mfaFactor.findMany({ where: { userId }, select: { id: true, confirmedAt: true, secretEnc: true }, orderBy: { id: 'asc' } }),
    d.recoveryCode.findMany({ where: { userId }, select: { id: true, usedAt: true }, orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({ u, sessions, factors, codes });
}

/** Everything of tenant B this sweep could disturb. Compared around every A operation. */
async function tenantBState(): Promise<string> {
  const d = db('B');
  const [users, sessions, factors, codes, settings, outbox, products] = await Promise.all([
    d.userAccount.findMany({ select: { id: true, username: true, status: true, passwordHash: true, email: true }, orderBy: { id: 'asc' } }),
    d.session.findMany({ select: { id: true, restricted: true, mfaAt: true, stepUpAt: true, revokedAt: true }, orderBy: { id: 'asc' } }),
    d.mfaFactor.findMany({ select: { id: true, confirmedAt: true }, orderBy: { id: 'asc' } }),
    d.recoveryCode.findMany({ select: { id: true, usedAt: true }, orderBy: { id: 'asc' } }),
    d.setting.findMany({ select: { id: true, key: true, value: true, version: true }, orderBy: { id: 'asc' } }),
    d.outboxEvent.count(),
    h.platform.tenantProduct.findMany({ where: { tenantId: tenant.B }, select: { product: true, entitled: true, enabled: true }, orderBy: { product: 'asc' } }),
  ]);
  return JSON.stringify({ users, sessions, factors, codes, settings, outbox, products });
}

// ---------------------------------------------------------------------------------------------------
// Fixtures shared by the sweep
// ---------------------------------------------------------------------------------------------------
let adminA: Person;
let regA: Person;
let regB: Person;
// "00" sorts before seeded and generated usernames: GET /users returns the first 50 by username.
const marker = { userA: `00ZZA${run}`, userB: `00ZZB${run}` };
let markerUserA = '';
let markerUserB = '';
const SETTING_A = { min: 13, max: 37 };
const SETTING_B = { min: 2, max: 59 };
const ETAG = async (cookie: string) => String((await send({ method: 'GET', host: A, url: '/api/v1/settings/registration.unitLimits', cookie })).headers.etag);

/** B's names that must never appear through A. */
const bMarkers = () => [marker.userB, '"max":59', 'Test State Polytechnic', tenant.B, FILE_B_NAME];

// Files (spec 0010 FU2): A's Registrar owns A's files; a second A user and B's Registrar own others.
const FILE_A_NAME = `00FA${run}.pdf`;
const FILE_B_NAME = `00FB${run}.pdf`;
const pdfBytes = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag} ${randomBytes(6).toString('hex')}\n%%EOF\n`);
let fileA = '';
let fileA2 = '';
let fileB = '';
let scanner: FileScanWorker;

/** Upload through the real flow (slot → presigned POST → complete) and scan it; returns the id. */
async function uploadFile(p: Person, name: string, opts: { complete?: boolean; scan?: boolean } = {}): Promise<string> {
  const bytes = pdfBytes(name);
  const res = await send({ method: 'POST', host: p.host, url: '/api/v1/files/uploads', cookie: p.session, body: { name, mime: 'application/pdf', sizeBytes: bytes.length } });
  expectStatus(res, 201);
  const slot = json(res) as { file: { id: string }; upload: { url: string; fields: Record<string, string> } };
  const form = new FormData();
  for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'upload');
  expect((await fetch(slot.upload.url, { method: 'POST', body: form })).status).toBe(204);
  if (opts.complete === false) return slot.file.id;
  expectStatus(await send({ method: 'POST', host: p.host, url: `/api/v1/files/${slot.file.id}/complete`, cookie: p.session }), 200);
  if (opts.scan !== false) {
    const ref = { id: tenant[p.t], shardId };
    for (let i = 0; i < 3; i++) {
      await scanner.scanTenant(ref);
      if ((await db(p.t).fileObject.findUniqueOrThrow({ where: { id: slot.file.id } })).state === 'CLEAN') break;
    }
  }
  return slot.file.id;
}
const fileState = async (t: 'A' | 'B', id: string) =>
  JSON.stringify(await db(t).fileObject.findUniqueOrThrow({ where: { id }, select: { state: true, reservedBytes: true, cleanKey: true, deletedAt: true } }), (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

// ---------------------------------------------------------------------------------------------------
// Route declarations: authentication kind, isolation classes, and the exact legitimate fixture (RS0)
// ---------------------------------------------------------------------------------------------------
interface Prepared {
  req: Req;
  /** Exact status, business fields and persisted effects of the legitimate operation. */
  verify: (res: InjectResult) => void | Promise<void>;
}
interface Decl {
  auth: AuthKind;
  classes: IsolationClass[];
  /** Synthetic negative control (RS8): never in production. */
  control?: boolean;
  /** A request that would succeed if the credential were valid (RS2 probes). */
  skeleton?: (cookie?: string) => Req;
  /** RS0: a fresh, fully-equipped legitimate request for tenant A. */
  prepare?: () => Prepared | Promise<Prepared>;
  /** The route parses a strict JSON body: an unknown `tenantId` field is the documented 400. */
  strictBody?: boolean;
}

const expectStatus = (res: InjectResult, status: number) => {
  if (res.statusCode !== status) throw new Error(`expected ${String(status)}, got ${String(res.statusCode)}: ${res.body.slice(0, 300)}`);
};

const DECLS: Record<RouteKey, Decl> = {
  'GET /health/live': { auth: 'none', classes: [], prepare: () => ({ req: { method: 'GET', host: A, url: '/health/live' }, verify: (r) => { expectStatus(r, 200); expect(json(r)).toEqual({ status: 'ok' }); } }) },
  'GET /health/ready': { auth: 'none', classes: [], prepare: () => ({ req: { method: 'GET', host: A, url: '/health/ready' }, verify: (r) => { expectStatus(r, 200); expect(json(r)).toEqual({ status: 'ready' }); } }) },

  'GET /api/v1/tenant/public-profile': {
    auth: 'public',
    classes: ['collection'],
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/tenant/public-profile' },
      verify: (r) => {
        expectStatus(r, 200);
        expect(json(r)).toMatchObject({ slug: 'demo-uni' });
      },
    }),
  },

  'POST /api/v1/auth/login': {
    auth: 'public',
    classes: ['public-auth'],
    strictBody: true,
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const before = await db('A').session.count({ where: { userId: u.id } });
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: u.username, password: PASSWORD } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ user: { id: u.id, username: u.username } });
          expect(sessionOf(r)).toBeDefined();
          expect(await db('A').session.count({ where: { userId: u.id } })).toBe(before + 1);
        },
      };
    },
  },

  'POST /api/v1/auth/activation/request': {
    auth: 'public',
    classes: ['public-auth'],
    strictBody: true,
    prepare: async () => {
      const u = await user('A', 'STUDENT', { status: 'PENDING_ACTIVATION' });
      const before = h.mailsTo(u.email).length;
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/activation/request', body: { username: u.username } },
        verify: async (r) => {
          expectStatus(r, 202);
          await h.waitForMail(u.email, /activation code/, before);
        },
      };
    },
  },

  'POST /api/v1/auth/activation/confirm': {
    auth: 'public',
    classes: ['public-auth'],
    strictBody: true,
    prepare: async () => {
      const u = await user('A', 'STUDENT', { status: 'PENDING_ACTIVATION' });
      expectStatus(await send({ method: 'POST', host: A, url: '/api/v1/auth/activation/request', body: { username: u.username } }), 202);
      const code = codeIn(await h.waitForMail(u.email, /activation code/, 0));
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/activation/confirm', body: { username: u.username, code, password: pw('Act') } },
        verify: async (r) => {
          expectStatus(r, 204);
          expect((await db('A').userAccount.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('ACTIVE');
        },
      };
    },
  },

  'POST /api/v1/auth/password-reset/request': {
    auth: 'public',
    classes: ['public-auth'],
    strictBody: true,
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const before = h.mailsTo(u.email).length;
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/password-reset/request', body: { username: u.username } },
        verify: async (r) => {
          expectStatus(r, 202);
          await h.waitForMail(u.email, /password reset code/, before);
        },
      };
    },
  },

  'POST /api/v1/auth/password-reset/confirm': {
    auth: 'public',
    classes: ['public-auth'],
    strictBody: true,
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      expectStatus(await send({ method: 'POST', host: A, url: '/api/v1/auth/password-reset/request', body: { username: u.username } }), 202);
      const code = codeIn(await h.waitForMail(u.email, /password reset code/, 0));
      const hashBefore = (await db('A').userAccount.findUniqueOrThrow({ where: { id: u.id } })).passwordHash;
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/password-reset/confirm', body: { username: u.username, code, password: pw('Reset') } },
        verify: async (r) => {
          expectStatus(r, 204);
          expect((await db('A').userAccount.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).not.toEqual(hashBefore);
        },
      };
    },
  },

  'POST /api/v1/auth/mfa/verify': {
    auth: 'mfa-challenge',
    classes: ['public-auth', 'self'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/mfa/verify', ...(cookie ? { cookie } : {}), body: { code: '000000' } }),
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const secret = await enrolTestTotp(h.shard, tenant.A, u.id);
      const login = await send({ method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: u.username, password: PASSWORD } });
      expectStatus(login, 200);
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/mfa/verify', cookie: challengeOf(login)!, body: { code: totpCode(secret) } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ user: { id: u.id } });
          expect(await db('A').session.count({ where: { userId: u.id, mfaAt: { not: null } } })).toBe(1);
        },
      };
    },
  },

  'POST /api/v1/auth/step-up': {
    auth: 'session',
    classes: ['self'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/step-up', ...(cookie ? { cookie } : {}), body: { password: PASSWORD, code: '000000' } }),
    prepare: async () => {
      const p = await mfaPerson('A', 'STUDENT');
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/step-up', cookie: p.session, body: { password: PASSWORD, code: totpCode(p.secret!) } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toEqual({ stepUp: true });
          expect(await db('A').session.count({ where: { userId: p.id, stepUpAt: { not: null }, revokedAt: null } })).toBe(1);
        },
      };
    },
  },

  'POST /api/v1/auth/logout': {
    auth: 'restricted-session',
    classes: ['self'],
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/logout', ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const session = await signIn(A, u.username, PASSWORD);
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/logout', cookie: session },
        verify: async (r) => {
          expectStatus(r, 204);
          expect(await db('A').session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
        },
      };
    },
  },

  'GET /api/v1/auth/me': {
    auth: 'restricted-session',
    classes: ['self'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/auth/me', ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const session = await signIn(A, u.username, PASSWORD);
      return {
        req: { method: 'GET', host: A, url: '/api/v1/auth/me', cookie: session },
        verify: (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ id: u.id, username: u.username, restricted: false });
        },
      };
    },
  },

  'POST /api/v1/auth/mfa/totp/enrol': {
    auth: 'restricted-session',
    classes: ['self'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/enrol', ...(cookie ? { cookie } : {}), body: { password: PASSWORD } }),
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const session = await signIn(A, u.username, PASSWORD);
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/enrol', cookie: session, body: { password: PASSWORD } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(String(json(r).otpauthUri)).toMatch(/^otpauth:\/\/totp\//);
          expect(await db('A').mfaFactor.count({ where: { userId: u.id, confirmedAt: null } })).toBe(1);
        },
      };
    },
  },

  'POST /api/v1/auth/mfa/totp/confirm': {
    auth: 'restricted-session',
    classes: ['self'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/confirm', ...(cookie ? { cookie } : {}), body: { code: '000000' } }),
    prepare: async () => {
      const u = await user('A', 'STUDENT');
      const session = await signIn(A, u.username, PASSWORD);
      const begin = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/enrol', cookie: session, body: { password: PASSWORD } });
      expectStatus(begin, 200);
      const secret = base32Decode(String(json(begin).secret));
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/confirm', cookie: session, body: { code: totpCode(secret) } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r).recoveryCodes).toHaveLength(10);
          expect(await db('A').mfaFactor.count({ where: { userId: u.id, confirmedAt: { not: null } } })).toBe(1);
        },
      };
    },
  },

  'POST /api/v1/auth/mfa/totp/disable': {
    auth: 'session',
    classes: ['self'],
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/disable', ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const p = await mfaPerson('A', 'STUDENT');
      await stepUp(p);
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/disable', cookie: p.session },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toEqual({ mfa: false });
          expect(await db('A').mfaFactor.count({ where: { userId: p.id } })).toBe(0);
        },
      };
    },
  },

  'POST /api/v1/auth/mfa/recovery-codes/regenerate': {
    auth: 'session',
    classes: ['self'],
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/auth/mfa/recovery-codes/regenerate', ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const p = await mfaPerson('A', 'STUDENT');
      await stepUp(p);
      return {
        req: { method: 'POST', host: A, url: '/api/v1/auth/mfa/recovery-codes/regenerate', cookie: p.session },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r).recoveryCodes).toHaveLength(10);
          expect(await db('A').recoveryCode.count({ where: { userId: p.id, usedAt: null } })).toBe(10);
        },
      };
    },
  },

  'GET /api/v1/users': {
    auth: 'session',
    classes: ['collection'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/users', ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/users', cookie: adminA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(checkCollection('GET /api/v1/users', json(r), [marker.userA], bMarkers())).toEqual([]);
      },
    }),
  },

  'GET /api/v1/products': {
    auth: 'session',
    classes: ['self', 'collection'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/products', ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/products', cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        // A has Academics on and Admissions off; B the reverse (set for this sweep).
        expect(json(r)).toEqual({ data: ['academics', 'core'] });
      },
    }),
  },

  'GET /api/v1/admin/products': {
    auth: 'session',
    classes: ['collection'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/admin/products', ...(cookie ? { cookie } : {}) }),
    prepare: async () => ({
      req: { method: 'GET', host: A, url: '/api/v1/admin/products', cookie: await stepUp(adminA) },
      verify: (r) => {
        expectStatus(r, 200);
        const rows = json(r).data as { product: string; enabled: boolean }[];
        // B's opposite states must not show through: A sees its own Academics on, Admissions off.
        expect(rows.find((x) => x.product === 'academics')).toMatchObject({ enabled: true });
        expect(rows.find((x) => x.product === 'admissions')).toMatchObject({ enabled: false });
      },
    }),
  },

  'PUT /api/v1/admin/products/:product': {
    auth: 'session',
    classes: ['keyed'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'PUT', host: A, url: '/api/v1/admin/products/bursary', ...(cookie ? { cookie } : {}), body: { enabled: true } }),
    prepare: async () => {
      const cookie = await stepUp(adminA);
      const before = await h.platform.tenantProduct.findUniqueOrThrow({ where: { tenantId_product: { tenantId: tenant.A, product: 'bursary' } } });
      return {
        req: { method: 'PUT', host: A, url: '/api/v1/admin/products/bursary', cookie, body: { enabled: !before.enabled } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ product: 'bursary', enabled: !before.enabled });
          const after = await h.platform.tenantProduct.findUniqueOrThrow({ where: { tenantId_product: { tenantId: tenant.A, product: 'bursary' } } });
          expect(after.enabled).toBe(!before.enabled);
          // Restore through the API (keeps the app's product cache honest).
          expectStatus(await send({ method: 'PUT', host: A, url: '/api/v1/admin/products/bursary', cookie, body: { enabled: before.enabled } }), 200);
        },
      };
    },
  },

  'GET /api/v1/settings': {
    auth: 'session',
    classes: ['collection'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/settings', ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/settings', cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(checkCollection('GET /api/v1/settings', json(r), ['"max":37'], bMarkers())).toEqual([]);
      },
    }),
  },

  'GET /api/v1/settings/:key': {
    auth: 'session',
    classes: ['keyed'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/settings/registration.unitLimits', ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/settings/registration.unitLimits', cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(json(r)).toMatchObject({ key: 'registration.unitLimits', value: SETTING_A, source: 'tenant' });
      },
    }),
  },

  'PUT /api/v1/settings/:key': {
    auth: 'session',
    classes: ['keyed'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', ...(cookie ? { cookie } : {}), body: { value: SETTING_A }, headers: { 'if-match': '"v0"' } }),
    prepare: async () => {
      const cookie = await stepUp(regA);
      const etag = await ETAG(cookie);
      return {
        req: { method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: SETTING_A }, headers: { 'if-match': etag } },
        verify: (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ value: SETTING_A, source: 'tenant' });
          expect(String(r.headers.etag)).not.toBe(etag);
        },
      };
    },
  },

  'DELETE /api/v1/settings/:key': {
    auth: 'session',
    classes: ['keyed'],
    skeleton: (cookie) => ({ method: 'DELETE', host: A, url: '/api/v1/settings/registration.unitLimits', ...(cookie ? { cookie } : {}), headers: { 'if-match': '"v0"' } }),
    prepare: async () => {
      const cookie = await stepUp(regA);
      return {
        req: { method: 'DELETE', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, headers: { 'if-match': await ETAG(cookie) } },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ source: 'default', value: { min: 15, max: 24 } });
          // Put A's marker value back for the other checks.
          expectStatus(
            await send({ method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: SETTING_A }, headers: { 'if-match': String(r.headers.etag) } }),
            200,
          );
        },
      };
    },
  },

  // Files (spec 0010): one creation route, one collection, four resource routes (RS6, FU2).
  'POST /api/v1/files/uploads': {
    auth: 'session',
    classes: ['self'],
    strictBody: true,
    skeleton: (cookie) => ({ method: 'POST', host: A, url: '/api/v1/files/uploads', ...(cookie ? { cookie } : {}), body: { name: 'x.pdf', mime: 'application/pdf', sizeBytes: 10 } }),
    prepare: () => ({
      req: { method: 'POST', host: A, url: '/api/v1/files/uploads', cookie: regA.session, body: { name: 'slot.pdf', mime: 'application/pdf', sizeBytes: 42 } },
      verify: async (r) => {
        expectStatus(r, 201);
        const body = json(r) as { file: { id: string; state: string }; upload: { url: string } };
        expect(body.file.state).toBe('PENDING_UPLOAD');
        expect(body.upload.url).toMatch(/^http/);
        expect(await db('A').fileObject.findUniqueOrThrow({ where: { id: body.file.id } })).toMatchObject({ reservedBytes: 42n, uploadedById: regA.id });
      },
    }),
  },

  'GET /api/v1/files': {
    auth: 'session',
    classes: ['collection'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: '/api/v1/files', ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: '/api/v1/files', cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(checkCollection('GET /api/v1/files', json(r), [FILE_A_NAME], bMarkers())).toEqual([]);
      },
    }),
  },

  'GET /api/v1/files/:id': {
    auth: 'session',
    classes: ['resource'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: `/api/v1/files/${randomUUID()}`, ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: `/api/v1/files/${fileA}`, cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(json(r)).toMatchObject({ id: fileA, name: FILE_A_NAME, state: 'CLEAN' });
      },
    }),
  },

  'POST /api/v1/files/:id/complete': {
    auth: 'session',
    classes: ['resource'],
    skeleton: (cookie) => ({ method: 'POST', host: A, url: `/api/v1/files/${randomUUID()}/complete`, ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const id = await uploadFile(regA, `complete-${randomBytes(3).toString('hex')}.pdf`, { complete: false });
      return {
        req: { method: 'POST', host: A, url: `/api/v1/files/${id}/complete`, cookie: regA.session },
        verify: async (r) => {
          expectStatus(r, 200);
          expect(json(r)).toMatchObject({ id, state: 'UPLOADED' });
          expect((await db('A').fileObject.findUniqueOrThrow({ where: { id } })).state).toBe('UPLOADED');
        },
      };
    },
  },

  'GET /api/v1/files/:id/content': {
    auth: 'session',
    classes: ['resource'],
    skeleton: (cookie) => ({ method: 'GET', host: A, url: `/api/v1/files/${randomUUID()}/content`, ...(cookie ? { cookie } : {}) }),
    prepare: () => ({
      req: { method: 'GET', host: A, url: `/api/v1/files/${fileA}/content`, cookie: regA.session },
      verify: (r) => {
        expectStatus(r, 200);
        expect(r.headers['content-type']).toBe('application/pdf');
        expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      },
    }),
  },

  'DELETE /api/v1/files/:id': {
    auth: 'session',
    classes: ['resource'],
    skeleton: (cookie) => ({ method: 'DELETE', host: A, url: `/api/v1/files/${randomUUID()}`, ...(cookie ? { cookie } : {}) }),
    prepare: async () => {
      const id = await uploadFile(regA, `delete-${randomBytes(3).toString('hex')}.pdf`);
      return {
        req: { method: 'DELETE', host: A, url: `/api/v1/files/${id}`, cookie: regA.session },
        verify: async (r) => {
          expectStatus(r, 204);
          expect(await db('A').fileObject.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'DELETED', reservedBytes: 0n });
        },
      };
    },
  },

  // Synthetic negative controls (RS8). Registered only in this test app.
  'GET /api/v1/__test/leaky-user/:id': { auth: 'session', classes: ['resource'], control: true },
  'GET /api/v1/__test/leaky-users': { auth: 'session', classes: ['collection'], control: true },
};

const real = Object.entries(DECLS).filter(([, d]) => !d.control);
const withCredential = real.filter(([, d]) => d.auth === 'session' || d.auth === 'restricted-session');
const RESTRICTED_ALLOWED = new Set(['POST /api/v1/auth/mfa/totp/enrol', 'POST /api/v1/auth/mfa/totp/confirm', 'POST /api/v1/auth/logout', 'GET /api/v1/auth/me']);

const coverage: Record<string, number> = {};
const count = (k: string) => (coverage[k] = (coverage[k] ?? 0) + 1);

// ---------------------------------------------------------------------------------------------------
beforeAll(async () => {
  h = await createHarness();
  tenant.A = h.tenants.demo;
  tenant.B = h.tenants.poly;
  shardId = (await h.platform.tenant.findUniqueOrThrow({ where: { id: tenant.A } })).shardId;
  // Opposite product states in A and B (before the sweep app caches anything).
  const setProduct = (tenantId: string, product: string, enabled: boolean) =>
    h.platform.tenantProduct.update({ where: { tenantId_product: { tenantId, product } }, data: { enabled } });
  await setProduct(tenant.A, 'academics', true);
  await setProduct(tenant.A, 'admissions', false);
  await setProduct(tenant.B, 'admissions', true);

  config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const opts: CreateAppOptions = {
    extraControllers: [LeakyControlsController],
    extraProviders: [{ provide: LEAK_VICTIM, useValue: { tenantId: tenant.B, shardId } }],
    beforeInit: (f) => {
      captureRoutes(f, fastifyRoutes);
      attachConformance(f);
    },
  };
  app = await createApp(config, opts);

  markerUserA = (await user('A', 'STUDENT', { username: marker.userA })).id;
  markerUserB = (await user('B', 'STUDENT', { username: marker.userB, email: `${marker.userB.toLowerCase()}@poly.test` })).id;
  adminA = await mfaPerson('A', 'INSTITUTION_ADMIN');
  regA = await mfaPerson('A', 'REGISTRAR');
  regB = await mfaPerson('B', 'REGISTRAR');
  scanner = h.workerCtx.get(FileScanWorker);
  fileA = await uploadFile(regA, FILE_A_NAME);
  fileA2 = await uploadFile(await mfaPerson('A', 'STUDENT'), `00FA2${run}.pdf`);
  fileB = await uploadFile(regB, FILE_B_NAME);

  // Keyed markers: A's setting through the API, B's directly (B has no Academics, so no API for it).
  const cookie = await stepUp(regA);
  expectStatus(
    await send({ method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: SETTING_A }, headers: { 'if-match': await ETAG(cookie) } }),
    200,
  );
  await db('B').setting.upsert({
    where: { tenantId_key_scopeKey: { tenantId: tenant.B, key: 'registration.unitLimits', scopeKey: 'INSTITUTION' } },
    create: { tenantId: tenant.B, key: 'registration.unitLimits', value: SETTING_B, version: 1 },
    update: { value: SETTING_B },
  });
}, 180_000);

afterAll(async () => {
  const setProduct = (tenantId: string, product: string, enabled: boolean) =>
    h.platform.tenantProduct.update({ where: { tenantId_product: { tenantId, product } }, data: { enabled } });
  await setProduct(tenant.A, 'academics', false);
  await setProduct(tenant.B, 'admissions', false);
  await db('B').setting.deleteMany({ where: { key: 'registration.unitLimits' } });
  await app.close();
  await h.close();
  const realResources = real.filter(([, d]) => d.classes.includes('resource')).length;
  process.stdout.write(
    `\n[route-sweep] routes discovered: ${String(fastifyRoutes.size)} Fastify registrations ` +
      `(${String(nestCount)} declared in Nest) | real routes swept: ${String(real.length)} | coverage: ${JSON.stringify(coverage)} | ` +
      `real resource routes: ${realResources === 0 ? 'N/A: 0 routes' : String(realResources)} (plus 2 synthetic controls)\n`,
  );
});

// ---------------------------------------------------------------------------------------------------
describe('[RS1] route table from structured registrations', () => {
  it('[RS1] Fastify onRoute registrations match Nest declarations (HEAD twins of GET only)', () => {
    expect(fastifyRoutes.size).toBeGreaterThan(0);
    const nest = nestRoutes(app);
    nestCount = nest.size;
    expect(crossCheckRoutes(fastifyRoutes, nest)).toEqual([]);
  });

  it('[RS1] every served route is declared, and every declaration names a served route', () => {
    const served = new Set([...nestRoutes(app)]);
    const findings: Finding[] = [];
    for (const r of served) if (!DECLS[r]) findings.push({ route: r, rule: 'RS1', detail: 'no declaration' });
    for (const r of Object.keys(DECLS)) if (!served.has(r)) findings.push({ route: r, rule: 'RS1', detail: 'declared but not served' });
    expect(findings).toEqual([]);
    for (const [, d] of real) expect(d.prepare, 'every real route has an RS0 fixture').toBeDefined();
  });
});

// Spec 0011 OA2: the committed OpenAPI document against the routes this app actually serves.
type DocOp = { operationId: string; parameters?: { name: string; in: string; 'x-invalid': { status: number; code: string } }[] };
const openapi = JSON.parse(readFileSync(new URL('../../../packages/api-client/openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, DocOp>>;
};
const docOps = new Map<string, DocOp>(
  Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([m, op]) => [`${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`, op] as const),
  ),
);

describe('[OA2] the OpenAPI document covers exactly the routes the app serves', () => {
  it('[OA2] served routes (Nest DiscoveryService, cross-checked with Fastify in RS1) minus the named controls = documented operations', () => {
    const served: string[] = [...nestRoutes(app)].filter((r) => !(CONTROL_ROUTES as readonly string[]).includes(r));
    const documented = [...docOps.keys()];
    expect({ missingFromDoc: served.filter((r) => !docOps.has(r)), notServed: documented.filter((r) => !served.includes(r)) }).toEqual({
      missingFromDoc: [],
      notServed: [],
    });
    // The controls are served by this test app, and only by it.
    for (const r of CONTROL_ROUTES) expect(nestRoutes(app).has(r), r).toBe(true);
  });

  // Fresh people per route, not the sweep's shared ones: each route is called fully authorized, and the
  // shared users keep their rate-limit budget (step-up is limited per user).
  const CALLERS: Record<string, { role: string; stepUp?: true; body?: unknown; headers?: Record<string, string> }> = {
    'GET /api/v1/files/:id': { role: 'STUDENT' },
    'POST /api/v1/files/:id/complete': { role: 'STUDENT' },
    'GET /api/v1/files/:id/content': { role: 'STUDENT' },
    'DELETE /api/v1/files/:id': { role: 'STUDENT' },
    'GET /api/v1/settings/:key': { role: 'REGISTRAR' },
    'PUT /api/v1/settings/:key': { role: 'REGISTRAR', body: { value: SETTING_A }, headers: { 'if-match': '"v0"' } },
    'DELETE /api/v1/settings/:key': { role: 'REGISTRAR', headers: { 'if-match': '"v0"' } },
    'PUT /api/v1/admin/products/:product': { role: 'INSTITUTION_ADMIN', stepUp: true, body: { enabled: true } },
  };
  const withParams = [...docOps].filter(([, op]) => (op.parameters ?? []).some((x) => x.in === 'path')).map(([k]) => k);

  it('[OA2] every documented route with path parameters has a caller below (a new one must be added)', () => {
    expect(Object.keys(CALLERS).sort()).toEqual([...withParams].sort());
  });

  it.each(withParams)(
    '[OA2] %s: an invalid or unknown path value gets the documented status and code after authorization, never 400',
    async (route) => {
      const c = CALLERS[route]!;
      const who = await mfaPerson('A', c.role);
      const cookie = c.stepUp ? await stepUp(who) : who.session;
      const [method, path] = route.split(' ') as [Method, string];
      for (const p of docOps.get(route)!.parameters!.filter((x) => x.in === 'path')) {
        for (const bad of ['zz-not-valid', randomUUID()]) {
          const url = path.replace(`:${p.name}`, encodeURIComponent(bad));
          const res = await send({ method, host: A, url, cookie, ...(c.body === undefined ? {} : { body: c.body }), ...(c.headers ? { headers: c.headers } : {}) });
          expect([res.statusCode, json(res).code], `${route} with ${p.name}=${bad}`).toEqual([p['x-invalid'].status, p['x-invalid'].code]);
        }
      }
    },
    60_000,
  );

  // Authorization order: the documented 404 is only reachable after authorization. The same invalid and
  // unknown values with no credentials are 401, so an unauthenticated caller learns nothing about them.
  it.each(withParams)('[OA2] %s: the same invalid or unknown path value without credentials is 401, not the 404', async (route) => {
    const c = CALLERS[route]!;
    const [method, path] = route.split(' ') as [Method, string];
    for (const p of docOps.get(route)!.parameters!.filter((x) => x.in === 'path')) {
      for (const bad of ['zz-not-valid', randomUUID()]) {
        const url = path.replace(`:${p.name}`, encodeURIComponent(bad));
        const res = await send({ method, host: A, url, ...(c.body === undefined ? {} : { body: c.body }), ...(c.headers ? { headers: c.headers } : {}) });
        expect([res.statusCode, json(res).code], `${route} with ${p.name}=${bad}, no session`).toEqual([401, 'auth.unauthenticated']);
      }
    }
  });
});

describe('[RS0][RS3] legitimate operation first, then tenant hints change nothing', () => {
  it.each(real.map(([k]) => k))('[RS0][RS3] %s', async (route) => {
    const d = DECLS[route]!;
    const bBefore = await tenantBState();
    // RS0: the legitimate operation succeeds exactly.
    const base = await d.prepare!();
    const res = await send(base.req);
    await base.verify(res);
    expect(containsAny(res.body, bMarkers()), 'no B marker in the baseline').toEqual([]);
    count('RS0 legitimate operations');

    // RS3: independent fresh fixtures for each hint.
    const hints: [string, (r: Req) => Req][] = [
      ['header', (r) => ({ ...r, headers: { ...r.headers, 'x-tenant-id': tenant.B } })],
      ['query', (r) => ({ ...r, url: `${r.url}${r.url.includes('?') ? '&' : '?'}tenantId=${tenant.B}` })],
    ];
    if (base.req.body !== undefined) hints.push(['body', (r) => ({ ...r, body: { ...(r.body as object), tenantId: tenant.B } })]);
    for (const [name, apply] of hints) {
      const p = await d.prepare!();
      const hinted = await send(apply(p.req));
      if (name === 'body' && d.strictBody) {
        expect(hinted.statusCode, `${route} ${name}`).toBe(400);
        expect(json(hinted).code).toBe('request.invalid');
      } else {
        await p.verify(hinted);
      }
      expect(containsAny(hinted.body, bMarkers()), `${route} ${name}: no B marker`).toEqual([]);
      count('RS3 hint variants');
    }
    expect(await tenantBState(), 'tenant B unchanged by A operations').toBe(bBefore);
  }, 120_000);
});

describe('[RS2] credentials by kind, exact answers', () => {
  it.each(withCredential.map(([k]) => k))('[RS2] %s: missing → 401, A on B host → 401', async (route) => {
    const skel = DECLS[route]!.skeleton!;
    const missing = await send(skel());
    expect([missing.statusCode, json(missing).code]).toEqual([401, 'auth.unauthenticated']);
    const crossHost = await send({ ...skel(adminA.session), host: B });
    expect([crossHost.statusCode, json(crossHost).code]).toEqual([401, 'auth.unauthenticated']);
    count('RS2 credential probes');
  });

  it('[RS2] mfa-challenge: missing challenge → 401; A’s challenge on B’s host → 401', async () => {
    const skel = DECLS['POST /api/v1/auth/mfa/verify']!.skeleton!;
    const missing = await send(skel());
    expect([missing.statusCode, json(missing).code]).toEqual([401, 'auth.mfa_invalid']);
    const u = await user('A', 'STUDENT');
    const secret = await enrolTestTotp(h.shard, tenant.A, u.id);
    const login = await send({ method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: u.username, password: PASSWORD } });
    const onB = await send({ ...skel(challengeOf(login)), host: B, body: { code: totpCode(secret) } });
    expect([onB.statusCode, json(onB).code]).toEqual([401, 'auth.mfa_invalid']);
    expect(await db('A').session.count({ where: { userId: u.id } })).toBe(0);
    count('RS2 credential probes');
  });

  it('[RS2][M8] the restricted session reaches exactly the M8 allow-list (enrol, confirm, logout, me)', async () => {
    const accepted: string[] = [];
    for (const [route, d] of withCredential) {
      const r = await restrictedSession();
      const res = await send(d.skeleton!(r.session));
      if (res.statusCode === 403 && json(res).code === 'auth.mfa_enrolment_required') continue;
      accepted.push(route);
    }
    expect(accepted.sort()).toEqual([...RESTRICTED_ALLOWED].sort());
    count('RS2 restricted-session probes');
  });

  it('[RS2] the suspended tenant’s host answers 423 on every tenant route', async () => {
    for (const [route, d] of real) {
      if (d.auth === 'none') continue;
      const [method, url] = route.split(' ') as [Method, string];
      const concrete = url.replace(':key', 'registration.unitLimits').replace(':product', 'bursary').replace(':id', randomUUID());
      const res = await send({ method, host: PAUSED, url: concrete, ...(method !== 'GET' ? { body: {} } : {}) });
      expect([route, res.statusCode, json(res).code]).toEqual([route, 423, 'tenant.suspended']);
      count('RS2 suspended-host probes');
    }
  });
});

describe('[RS4] collections never cross', () => {
  it('[RS4] the public profile is the host’s own institution', async () => {
    const a = json(await send({ method: 'GET', host: A, url: '/api/v1/tenant/public-profile' }));
    const b = json(await send({ method: 'GET', host: B, url: '/api/v1/tenant/public-profile' }));
    expect([a.slug, b.slug]).toEqual(['demo-uni', 'test-poly']);
    count('RS4 collection checks');
  });

  it('[RS4] users, settings and products lists carry A’s markers and no B marker', async () => {
    const users = await send({ method: 'GET', host: A, url: '/api/v1/users', cookie: adminA.session });
    expect(checkCollection('GET /api/v1/users', json(users), [marker.userA], bMarkers())).toEqual([]);
    const settings = await send({ method: 'GET', host: A, url: '/api/v1/settings', cookie: regA.session });
    expect(checkCollection('GET /api/v1/settings', json(settings), ['"max":37'], bMarkers())).toEqual([]);
    const products = await send({ method: 'GET', host: A, url: '/api/v1/products', cookie: regA.session });
    expect(checkCollection('GET /api/v1/products', json(products), ['"academics"'], ['"admissions"'])).toEqual([]);
    for (let i = 0; i < 3; i++) count('RS4 collection checks');
  });
});

describe('[RS5] keyed items are per tenant', () => {
  it('[RS5] same key, different values: A reads its own; A’s write and reset leave B byte-for-byte unchanged', async () => {
    const bRow = () => db('B').setting.findFirstOrThrow({ where: { key: 'registration.unitLimits' }, select: { value: true, version: true, updatedAt: true } });
    const before = JSON.stringify(await bRow());
    const read = await send({ method: 'GET', host: A, url: '/api/v1/settings/registration.unitLimits', cookie: regA.session });
    expect(json(read)).toMatchObject({ value: SETTING_A });
    const cookie = await stepUp(regA);
    const write = await send({ method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: { min: 14, max: 37 } }, headers: { 'if-match': await ETAG(cookie) } });
    expect([write.statusCode, json(write).value]).toEqual([200, { min: 14, max: 37 }]);
    expect(JSON.stringify(await bRow())).toBe(before);
    const back = await send({ method: 'PUT', host: A, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: SETTING_A }, headers: { 'if-match': String(write.headers.etag) } });
    expect(back.statusCode).toBe(200);
    expect(JSON.stringify(await bRow())).toBe(before);
    count('RS5 keyed checks');
  });

  it('[RS5] A’s product switch leaves B’s product rows unchanged', async () => {
    const bRows = () => h.platform.tenantProduct.findMany({ where: { tenantId: tenant.B }, orderBy: { product: 'asc' } });
    const before = JSON.stringify(await bRows());
    const cookie = await stepUp(adminA);
    expect((await send({ method: 'PUT', host: A, url: '/api/v1/admin/products/bursary', cookie, body: { enabled: true } })).statusCode).toBe(200);
    expect(JSON.stringify(await bRows())).toBe(before);
    expect((await send({ method: 'PUT', host: A, url: '/api/v1/admin/products/bursary', cookie, body: { enabled: false } })).statusCode).toBe(200);
    count('RS5 keyed checks');
  });

  it('[RS5] a key of a product the tenant has not active is 404 settings.unknown_key', async () => {
    const cookie = await stepUp(regB); // B has no Academics
    const res = await send({ method: 'PUT', host: B, url: '/api/v1/settings/registration.unitLimits', cookie, body: { value: SETTING_A }, headers: { 'if-match': '"v1"' } });
    expect([res.statusCode, json(res).code]).toEqual([404, 'settings.unknown_key']);
    count('RS5 keyed checks');
  });
});

describe('[RS6][RS8] resources by id, and the negative controls', () => {
  const resourceRoutes = real.filter(([, d]) => d.classes.includes('resource')).map(([k]) => k);

  it('[RS6] real resource routes exist now (spec 0010 FU2), reported separately from the controls', () => {
    expect(resourceRoutes.sort()).toEqual(['DELETE /api/v1/files/:id', 'GET /api/v1/files/:id', 'GET /api/v1/files/:id/content', 'POST /api/v1/files/:id/complete']);
  });

  it.each(resourceRoutes)('[RS6] %s: B’s id and another user’s id answer exactly like a nonexistent id; nothing changes', async (route) => {
    const [method, path] = route.split(' ') as [Method, string];
    const call = (id: string) => send({ method, host: A, url: path.replace(':id', id), cookie: regA.session });
    // The record reference is supplied only in the path (declared location).
    const bBefore = await fileState('B', fileB);
    const a2Before = await fileState('A', fileA2);
    const missing = await call(randomUUID());
    for (const [label, id] of [['otherTenant', fileB], ['sameTenantOtherUser', fileA2]] as const) {
      const answer = await call(id);
      const findings = checkResource(route, `path (${label})`, { own: { status: 200, body: {} }, otherTenant: { status: answer.statusCode, body: json(answer) }, missing: { status: missing.statusCode, body: json(missing) } }, FILE_B_NAME);
      expect(findings).toEqual([]);
      expect([answer.statusCode, json(answer).code]).toEqual([404, 'resource.not_found']);
    }
    expect(await fileState('B', fileB)).toBe(bBefore);
    expect(await fileState('A', fileA2)).toBe(a2Before);
    count('RS6 real resource checks');
  });

  it('[RS8][RS6] the leaky resource control really leaks, and the sweep reports exactly that leak', async () => {
    const route = 'GET /api/v1/__test/leaky-user/:id';
    const get = (id: string) => send({ method: 'GET', host: A, url: `/api/v1/__test/leaky-user/${id}`, cookie: regA.session });
    const own = await get(markerUserA);
    const otherTenant = await get(markerUserB);
    const missing = await get(randomUUID());
    // Step 1: the control is real (B's marker comes back through A's request).
    expect(otherTenant.statusCode).toBe(200);
    expect(otherTenant.body).toContain(marker.userB);
    // Step 2: the sweep's checker names exactly this leak, and nothing else.
    const findings = checkResource(route, 'path', { own: { status: own.statusCode, body: json(own) }, otherTenant: { status: otherTenant.statusCode, body: json(otherTenant) }, missing: { status: missing.statusCode, body: json(missing) } }, marker.userB);
    expect(findings).toEqual([{ route, rule: 'RS6', location: 'path', marker: marker.userB, detail: 'other tenant record exposed' }]);
    count('RS8 controls detected');
  });

  it('[RS8][RS6] the checker passes a correct resource route: B’s id answers exactly like a nonexistent id', () => {
    const notFound = { status: 404, body: { type: 'x', title: 'Not found', status: 404, code: 'resource.not_found', requestId: 'r1' } };
    const findings = checkResource('GET /example/:id', 'path', { own: { status: 200, body: { id: 'a' } }, otherTenant: notFound, missing: { ...notFound, body: { ...notFound.body, requestId: 'r2' } } }, 'ZZB');
    expect(findings).toEqual([]);
    // …and flags an existence oracle (403 for B's id vs 404 for a missing one).
    const oracle = checkResource('GET /example/:id', 'path', { own: { status: 200, body: {} }, otherTenant: { status: 403, body: { code: 'auth.forbidden' } }, missing: notFound }, 'ZZB');
    expect(oracle).toEqual([{ route: 'GET /example/:id', rule: 'RS6', location: 'path', detail: 'other tenant id answers differently from a nonexistent id' }]);
  });

  it('[RS8][RS4] the leaky collection control really leaks, and the sweep reports exactly that leak', async () => {
    const route = 'GET /api/v1/__test/leaky-users';
    const res = await send({ method: 'GET', host: A, url: '/api/v1/__test/leaky-users', cookie: regA.session });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(marker.userB); // step 1: real leak
    expect(checkCollection(route, json(res), [marker.userA], [marker.userB])).toEqual([
      { route, rule: 'RS4', marker: marker.userB, detail: 'other tenant marker exposed' },
    ]);
    count('RS8 controls detected');
  });

  it('[RS8] the compiled production build serves none of the control routes', async () => {
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    expect(existsSync(join(dist, 'bootstrap.js')), 'run `pnpm --filter @univarse/api build` first').toBe(true);
    // Static: no control path compiled anywhere into dist.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|mjs|cjs)$/.test(f) && readFileSync(p, 'utf8').includes('__test')) offenders.push(p);
      }
    };
    walk(dist);
    expect(offenders).toEqual([]);
    // Booted: the production build's own route table, captured the same way.
    const { createApp: createProdApp } = (await import(pathToFileURL(join(dist, 'bootstrap.js')).href)) as { createApp: typeof createApp };
    const prodRoutes = new Set<RouteKey>();
    const prod = await createProdApp(config, { beforeInit: (f) => captureRoutes(f, prodRoutes) });
    try {
      expect(prodRoutes.size).toBeGreaterThan(0);
      expect([...prodRoutes].filter((r) => r.includes('__test'))).toEqual([]);
      expect([...prodRoutes].filter((r) => !r.startsWith('HEAD ')).sort()).toEqual(real.map(([k]) => k).sort());
    } finally {
      await prod.close();
    }
    count('RS8 production-build checks');
  }, 60_000);
});

describe('[RS7] account actions stay with their account and tenant', () => {
  const SAME = `ZZSAME${run}`;
  let sameA: { id: string; email: string };
  let sameB: { id: string; email: string };

  beforeAll(async () => {
    sameA = await user('A', 'STUDENT', { username: SAME, email: `${SAME.toLowerCase()}@a.test` });
    sameB = await user('B', 'STUDENT', { username: SAME, email: `${SAME.toLowerCase()}@b.test` });
    await db('B').userAccount.update({ where: { id: sameB.id }, data: { passwordHash: await hashPassword(OTHER_PASSWORD) } });
  }, 60_000);

  it('[RS7] login binds to the host’s tenant: A’s password on A works, B’s password on A fails, B untouched', async () => {
    const bState = await accountState('B', sameB.id);
    const ok = await send({ method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: SAME, password: PASSWORD } });
    expect([ok.statusCode, (json(ok).user as { id: string }).id]).toEqual([200, sameA.id]);
    expect(await db('A').session.count({ where: { userId: sameA.id } })).toBe(1);
    const wrong = await send({ method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: SAME, password: OTHER_PASSWORD } });
    expect([wrong.statusCode, json(wrong).code]).toEqual([401, 'auth.invalid_credentials']);
    expect(await db('A').session.count({ where: { userId: sameA.id } })).toBe(1);
    expect(await accountState('B', sameB.id)).toBe(bState);
    count('RS7 account checks');
  });

  it('[RS7] MFA challenges stay with their tenant and user: not on B’s host, not with B’s code', async () => {
    const uA = await user('A', 'STUDENT', { username: `ZZMFA${run}`, email: `zzmfa${run.toLowerCase()}@a.test` });
    const uB = await user('B', 'STUDENT', { username: `ZZMFA${run}`, email: `zzmfa${run.toLowerCase()}@b.test` });
    const sA = await enrolTestTotp(h.shard, tenant.A, uA.id);
    const sB = await enrolTestTotp(h.shard, tenant.B, uB.id);
    const bState = await accountState('B', uB.id);
    const login = await send({ method: 'POST', host: A, url: '/api/v1/auth/login', body: { username: uA.username, password: PASSWORD } });
    const challenge = challengeOf(login)!;
    const onB = await send({ method: 'POST', host: B, url: '/api/v1/auth/mfa/verify', cookie: challenge, body: { code: totpCode(sB) } });
    expect([onB.statusCode, json(onB).code]).toEqual([401, 'auth.mfa_invalid']);
    const bCode = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/verify', cookie: challenge, body: { code: totpCode(sB) } });
    expect([bCode.statusCode, json(bCode).code]).toEqual([401, 'auth.mfa_invalid']);
    const ok = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/verify', cookie: challenge, body: { code: totpCode(sA) } });
    expect([ok.statusCode, (json(ok).user as { id: string }).id]).toEqual([200, uA.id]);
    expect(await accountState('B', uB.id)).toBe(bState);
    count('RS7 account checks');
  });

  it('[RS7] activation and reset: email only to A’s address, code only valid on A’s host, only A’s account changes', async () => {
    for (const [kind, status, subject] of [
      ['activation', 'PENDING_ACTIVATION', /activation code/],
      ['password-reset', 'ACTIVE', /password reset code/],
    ] as const) {
      const name = `ZZ${kind === 'activation' ? 'ACT' : 'RST'}${run}`;
      const uA = await user('A', 'STUDENT', { username: name, email: `${name.toLowerCase()}@a.test`, status });
      const uB = await user('B', 'STUDENT', { username: name, email: `${name.toLowerCase()}@b.test`, status });
      const bState = await accountState('B', uB.id);
      const bOutbox = await db('B').outboxEvent.count();
      expect((await send({ method: 'POST', host: A, url: `/api/v1/auth/${kind}/request`, body: { username: name } })).statusCode).toBe(202);
      const code = codeIn(await h.waitForMail(uA.email, subject, 0));
      await h.deliver();
      expect(h.mailsTo(uB.email)).toHaveLength(0);
      expect(await db('B').outboxEvent.count()).toBe(bOutbox);
      const onB = await send({ method: 'POST', host: B, url: `/api/v1/auth/${kind}/confirm`, body: { username: name, code, password: pw('NotB') } });
      expect([onB.statusCode, json(onB).code]).toEqual([400, kind === 'activation' ? 'auth.activation_invalid' : 'auth.reset_invalid']);
      const ok = await send({ method: 'POST', host: A, url: `/api/v1/auth/${kind}/confirm`, body: { username: name, code, password: pw('OnlyA') } });
      expect(ok.statusCode).toBe(204);
      expect(await accountState('B', uB.id)).toBe(bState);
      count('RS7 account checks');
    }
  });

  it('[RS7] self routes change only the caller: A2 and B’s same-username user are untouched', async () => {
    const a1 = await mfaPerson('A', 'STUDENT');
    const a2 = await mfaPerson('A', 'STUDENT');
    const others = async () => [await accountState('A', a2.id), await accountState('B', sameB.id)].join('|');
    const before = await others();
    const me = await send({ method: 'GET', host: A, url: '/api/v1/auth/me', cookie: a1.session });
    expect(json(me)).toMatchObject({ id: a1.id });
    await stepUp(a1);
    expect((await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/recovery-codes/regenerate', cookie: a1.session })).statusCode).toBe(200);
    const disable = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/disable', cookie: a1.session });
    expect(disable.statusCode).toBe(200);
    a1.session = sessionOf(disable)!;
    const begin = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/enrol', cookie: a1.session, body: { password: PASSWORD } });
    expect(begin.statusCode).toBe(200);
    const confirm = await send({ method: 'POST', host: A, url: '/api/v1/auth/mfa/totp/confirm', cookie: a1.session, body: { code: totpCode(base32Decode(String(json(begin).secret))) } });
    expect(confirm.statusCode).toBe(200);
    expect((await send({ method: 'POST', host: A, url: '/api/v1/auth/logout', cookie: sessionOf(confirm)! })).statusCode).toBe(204);
    expect(await others()).toBe(before);
    count('RS7 account checks');
  });
});

describe('[RS9] same identities as production', () => {
  it('[RS9] the sweep runs as the app database role, without RLS bypass', async () => {
    const rows = await h.shard.$queryRaw<{ user: string; bypass: boolean; superuser: boolean }[]>`
      SELECT current_user::text AS user, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toMatchObject({ bypass: false, superuser: false });
    expect(rows[0]!.user).toMatch(/^univarse_app/);
  });
});
