// Spec 0027 P3: the tenant API refuses the platform's paths before any route runs, even a route that exists.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPlatformRefusal } from './fastify-hooks.js';

async function app() {
  const f = Fastify();
  registerPlatformRefusal(f);
  // A route at the platform's path: if the hook didn't run first, this would answer.
  f.get('/api/platform/v1/staff', () => ({ leaked: true }));
  f.get('/api/platformer', () => ({ ok: true }));
  f.get('/api/v1/tenant/public-profile', () => ({ ok: true }));
  await f.ready();
  return f;
}

describe('[P3] the tenant API never serves /api/platform', () => {
  it('answers 404 resource.not_found before the route, in any case and with any query', async () => {
    const f = await app();
    for (const url of ['/api/platform/v1/staff', '/API/Platform/v1/staff', '/api/platform/v1/staff?x=1', '/api/platform', '/api/platform/']) {
      const res = await f.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('resource.not_found');
      expect(res.body).not.toContain('leaked');
    }
  });

  it('leaves every other path alone, a look-alike prefix included', async () => {
    const f = await app();
    expect((await f.inject({ method: 'GET', url: '/api/v1/tenant/public-profile' })).statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/api/platformer' })).statusCode).toBe(200);
  });
});
