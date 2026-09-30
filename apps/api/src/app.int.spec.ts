/**
 * HTTP-level tenancy tests against the real platform + pool databases.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`.
 */
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let app: NestFastifyApplication;
const get = (url: string, host: string, headers: Record<string, string> = {}) =>
  app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: { host, ...headers } });

beforeAll(async () => {
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('live and ready need no tenant', async () => {
    expect((await get('/health/live', 'anything.example')).statusCode).toBe(200);
    const ready = await get('/health/ready', 'anything.example');
    expect(ready.json()).toEqual({ status: 'ready' });
  });
});

describe('tenant resolution from Host', () => {
  it('serves the tenant that owns the host', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'demo-uni.univarse.localhost');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: 'demo-uni', shortName: 'DEMO-UNI', legalName: 'Demo University, Lagos', type: 'UNIVERSITY' });
  });

  it('is case-insensitive and ignores the port', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'TEST-POLY.univarse.localhost:3000');
    expect(res.json()).toMatchObject({ slug: 'test-poly' });
  });

  it('unknown hosts get a 404 problem, never another tenant', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'nobody.univarse.localhost');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'tenant.not_found', status: 404 });
  });

  it('malformed hosts are rejected without a lookup', async () => {
    const res = await get('/api/v1/tenant/public-profile', "demo-uni.univarse.localhost';--");
    expect(res.statusCode).toBe(404);
  });

  it('a suspended tenant returns 423', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'paused-uni.univarse.localhost');
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ code: 'tenant.suspended' });
  });

  it('ignores client-supplied tenant hints and forwarded hosts (TRUST_PROXY=false)', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'nobody.univarse.localhost', {
      'x-tenant-slug': 'demo-uni',
      'x-forwarded-host': 'demo-uni.univarse.localhost',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('http hygiene', () => {
  it('sets security headers and echoes a request id', async () => {
    const res = await get('/api/v1/tenant/public-profile', 'demo-uni.univarse.localhost', { 'x-request-id': 'req-test-12345' });
    expect(res.headers).toMatchObject({
      'x-request-id': 'req-test-12345',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('replaces malformed request ids', async () => {
    const res = await get('/health/live', 'x', { 'x-request-id': '<script>' });
    expect(res.headers['x-request-id']).not.toBe('<script>');
  });

  it('unknown routes return a problem document with the request id', async () => {
    const res = await get('/api/v1/does-not-exist', 'demo-uni.univarse.localhost');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, requestId: expect.any(String) });
  });
});
