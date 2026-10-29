// Spec 0027 P3, P4: the platform API's walls on a bare Fastify, with real routes behind them, so each wall is seen to
// stop a request that would otherwise be answered. The integration test runs the same walls in the full app.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPlatformWalls } from './platform-app.js';
import { loadPlatformConfig } from './platform-config.js';

const EDGE = '172.31.219.10';
const GATEWAY = '172.31.218.1';

async function app() {
  const f = Fastify({ trustProxy: [EDGE] });
  registerPlatformWalls(f, loadPlatformConfig({ NODE_ENV: 'test', CONSOLE_DATABASE_URL: 'postgresql://x', CONSOLE_ALLOWLIST: GATEWAY }));
  f.get('/api/platform/v1/staff', () => ({ reached: 'platform' }));
  f.get('/api/v1/auth/me', () => ({ reached: 'tenant-shaped' }));
  f.get('/health/live', () => ({ status: 'ok' }));
  await f.ready();
  const get = (url: string, forwardedFor?: string, remoteAddress = EDGE) =>
    f.inject({ method: 'GET', url, remoteAddress, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} });
  return get;
}

describe('[P4] the allowlist', () => {
  it('lets the allowlisted address through the edge to a platform route', async () => {
    const get = await app();
    expect((await get('/api/platform/v1/staff', GATEWAY)).json()).toEqual({ reached: 'platform' });
  });

  it('answers 404 resource.not_found to any other address, without reaching the route', async () => {
    const get = await app();
    for (const [xff, peer] of [['172.31.218.7', EDGE], [GATEWAY, '172.31.218.99'], [`${GATEWAY}, 172.31.218.7`, EDGE]] as const) {
      const res = await get('/api/platform/v1/staff', xff, peer);
      expect(res.statusCode, `${xff} via ${peer}`).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('resource.not_found');
    }
  });
});

describe('[P3] the prefix', () => {
  it('a path outside /api/platform/v1/ is 404 even from the allowlisted address, a route there included', async () => {
    const get = await app();
    const res = await get('/api/v1/auth/me', GATEWAY);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('tenant-shaped');
    expect((await get('/', GATEWAY)).statusCode).toBe(404);
  });

  it('health answers without the allowlist: it is for the container network, never routed by the edge', async () => {
    const get = await app();
    expect((await get('/health/live', undefined, '172.31.219.20')).statusCode).toBe(200);
  });
});
