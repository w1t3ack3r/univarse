import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { problemType } from '../errors/problem.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Accept an upstream request id only if it is well-formed; otherwise mint one. */
export function genRequestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence (docs/08 §3.5): state-changing API requests must come from our own origin.
 * Fetch Metadata first; fall back to Origin for browsers without it. Requests carrying neither
 * are refused — the web app's server-side calls set Origin explicitly.
 */
export function registerCsrfGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!UNSAFE.has(req.method) || !req.url.startsWith('/api/')) return;
    const site = req.headers['sec-fetch-site'];
    let ok: boolean;
    if (typeof site === 'string') {
      ok = site === 'same-origin';
    } else {
      const origin = req.headers.origin;
      try {
        ok = typeof origin === 'string' && new URL(origin).host.toLowerCase() === req.host.toLowerCase();
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      return reply.status(403).header('content-type', 'application/problem+json').send({
        type: problemType('request.csrf_rejected'),
        title: 'Cross-site request rejected',
        status: 403,
        code: 'request.csrf_rejected',
        requestId: req.id,
      });
    }
  });
}

/** API security headers (docs/08-security.md §6). The web app sets its own CSP with nonces. */
export function registerSecurityHeaders(app: FastifyInstance, opts: { production: boolean }): void {
  app.addHook('onSend', async (req, reply, payload) => {
    void reply.header('x-request-id', req.id);
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    void reply.header('cross-origin-resource-policy', 'same-origin');
    // `sandbox`: the API never serves anything a browser should run; this also covers file downloads
    // (spec 0010 FU5). Set here, after handlers, so no route can weaken it.
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    void reply.header('cache-control', 'no-store');
    if (opts.production) {
      void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
    }
    reply.removeHeader('x-powered-by');
    return payload;
  });
}
