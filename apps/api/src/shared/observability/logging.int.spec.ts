// Spec 0012 OB2/OB3/OB7 against the real app: every request ends with one summary line, severity by
// outcome (D5), ids from the Host and the session, and security events on their own stream.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { FilesService } from '../../modules/files/files.service.js';
import { cookieFrom, createHarness, HOSTS, randomIp, type Harness } from '../../testing/int-harness.js';

type Line = Record<string, unknown> & { level: string; msg: string; event: string | null };
const lines: Line[] = [];
const raw: string[] = [];
let h: Harness;
let app: NestFastifyApplication;

const inject = (o: { method?: 'GET' | 'POST'; url: string; host?: string; cookie?: string; body?: object; headers?: Record<string, string> }) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: o.method ?? 'GET',
      url: o.url,
      remoteAddress: randomIp(),
      headers: {
        host: o.host ?? HOSTS.demo,
        ...(o.method === 'POST' ? { 'sec-fetch-site': 'same-origin' } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...o.headers,
      },
      ...(o.body ? { payload: o.body } : {}),
    });

/** The lines a request produced, found by the request id the API returned. */
const linesFor = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);
const summary = (requestId: unknown) => linesFor(requestId).filter((l) => l.event === 'http.request');

beforeAll(async () => {
  h = await createHarness();
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) {
        raw.push(l);
        lines.push(JSON.parse(l) as Line);
      }
      done();
    },
  });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'debug' }), { logDestination: destination });
}, 60_000);
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('[OB3] one summary line per request, by route template, severity by outcome', () => {
  it('[OB3][OB2] a public 200: info, route template, tenant from the Host, user null', async () => {
    const res = await inject({ url: '/api/v1/tenant/public-profile' });
    const [line, ...more] = summary(res.headers['x-request-id']);
    expect(more).toEqual([]);
    expect(line).toMatchObject({
      level: 'info',
      event: 'http.request',
      method: 'GET',
      route: '/api/v1/tenant/public-profile',
      status: 200,
      tenantId: h.tenants.demo,
      userId: null,
      service: 'api',
      module: 'http',
    });
    expect(typeof line!.durationMs).toBe('number');
  });

  it('[OB3][OB2] a signed-in 404 on a resource: info (signed in changes nothing), the template not the id, the user from the session', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: u.username, password: 'Correct-Horse-Battery-9' } })).headers['set-cookie']);
    const missing = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const res = await inject({ url: `/api/v1/files/${missing}`, cookie });
    expect(res.statusCode).toBe(404);
    expect(summary(res.headers['x-request-id'])[0]).toMatchObject({ level: 'info', route: '/api/v1/files/:id', status: 404, userId: u.id, tenantId: h.tenants.demo });
    expect(linesFor(res.headers['x-request-id']).some((l) => JSON.stringify(l).includes(missing))).toBe(false);
  });

  it('[OB3] query strings never reach the log', async () => {
    const secret = `q-${randomBytes(6).toString('hex')}`;
    await inject({ url: `/api/v1/tenant/public-profile?token=${secret}&x=1` });
    expect(raw.some((l) => l.includes(secret))).toBe(false);
  });

  it('[OB3] a 5xx is error; the unhandled error is logged with its event and no stack in msg', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const cookie = cookieFrom((await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: u.username, password: 'Correct-Horse-Battery-9' } })).headers['set-cookie']);
    const spy = vi.spyOn(app.get(FilesService), 'list').mockRejectedValueOnce(new Error('shard down'));
    try {
      const res = await inject({ url: '/api/v1/files', cookie });
      expect(res.statusCode).toBe(500);
      const mine = linesFor(res.headers['x-request-id']);
      expect(mine.find((l) => l.event === 'http.request')).toMatchObject({ level: 'error', status: 500, route: '/api/v1/files' });
      expect(mine.find((l) => l.event === 'http.unhandled_error')).toMatchObject({ level: 'error', msg: 'Unhandled error', err: { type: 'Error', message: 'shard down' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('[OB3] health probes are debug, tenantless', async () => {
    const res = await inject({ url: '/health/live' });
    expect(summary(res.headers['x-request-id'])[0]).toMatchObject({ level: 'debug', route: '/health/live', tenantId: null, userId: null });
  });
});

describe('[OB7] security events: their own warn line on the security stream', () => {
  it('[OB7][OB3] a CSRF rejection: the summary stays info (403); the security line is warn', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { host: HOSTS.demo, 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(403);
    const mine = linesFor(res.headers['x-request-id']);
    expect(mine.find((l) => l.event === 'http.request')).toMatchObject({ level: 'info', status: 403 });
    expect(mine.find((l) => l.event === 'http.csrf_rejected')).toMatchObject({ level: 'warn', stream: 'security', route: '/api/v1/auth/logout', tenantId: null });
  });

  it('[OB7] a rate-limit violation: warn on the security stream, the bucket name only (no identifier)', async () => {
    const who = `nobody-${randomBytes(4).toString('hex')}`;
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', body: { username: who } }));
    const last = answers[3]!; // 3 per 15 min per account: the fourth is refused
    expect(last.statusCode).toBe(429);
    const mine = linesFor(last.headers['x-request-id']);
    expect(mine.find((l) => l.event === 'auth.rate_limited')).toMatchObject({ level: 'warn', stream: 'security', bucket: 'reset-req:id', tenantId: h.tenants.demo });
    expect(mine.find((l) => l.event === 'http.request')).toMatchObject({ level: 'info', status: 429 });
    expect(raw.some((l) => l.includes(who))).toBe(false);
  });
});
