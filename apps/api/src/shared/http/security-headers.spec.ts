// Spec 0033 Q-C1: every API response is no-store, set after the handler; the one value a route may keep is the
// immutable policy, and only on a 200 PNG or WebP.
import Fastify, { type FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { IMMUTABLE_IMAGE, registerSecurityHeaders } from './fastify-hooks.js';

async function app() {
  const f = Fastify();
  registerSecurityHeaders(f, { production: false });
  const send = (reply: FastifyReply, status: number, type: string, cache: string) =>
    reply.code(status).header('content-type', type).header('cache-control', cache).send(type.startsWith('image/') ? Buffer.from([1, 2, 3]) : '{}');
  f.get('/png', (_q, r) => send(r, 200, 'image/png', IMMUTABLE_IMAGE));
  f.get('/webp', (_q, r) => send(r, 200, 'image/webp', IMMUTABLE_IMAGE));
  f.get('/png-404', (_q, r) => send(r, 404, 'image/png', IMMUTABLE_IMAGE));
  f.get('/png-304', (_q, r) => r.code(304).header('content-type', 'image/png').header('cache-control', IMMUTABLE_IMAGE).send());
  f.get('/json', (_q, r) => send(r, 200, 'application/json', IMMUTABLE_IMAGE));
  f.get('/svg', (_q, r) => send(r, 200, 'image/svg+xml', IMMUTABLE_IMAGE));
  f.get('/png-other', (_q, r) => send(r, 200, 'image/png', 'public, max-age=60'));
  await f.ready();
  return f;
}

describe('[Q-C1] the API cache policy', () => {
  it('keeps the immutable policy only on a 200 PNG or WebP', async () => {
    const f = await app();
    for (const url of ['/png', '/webp']) expect((await f.inject({ method: 'GET', url })).headers['cache-control'], url).toBe(IMMUTABLE_IMAGE);
  });

  it('replaces anything else with no-store: another status, another type, another policy', async () => {
    const f = await app();
    for (const url of ['/png-404', '/png-304', '/json', '/svg', '/png-other']) {
      const res = await f.inject({ method: 'GET', url });
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.headers['content-security-policy'], url).toContain('sandbox');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
    }
  });
});
