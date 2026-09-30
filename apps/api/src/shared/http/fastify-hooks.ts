import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Accept an upstream request id only if it is well-formed; otherwise mint one. */
export function genRequestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** API security headers (docs/08-security.md §6). The web app sets its own CSP with nonces. */
export function registerSecurityHeaders(app: FastifyInstance, opts: { production: boolean }): void {
  app.addHook('onSend', async (req, reply, payload) => {
    void reply.header('x-request-id', req.id);
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    void reply.header('cross-origin-resource-policy', 'same-origin');
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    void reply.header('cache-control', 'no-store');
    if (opts.production) {
      void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
    }
    reply.removeHeader('x-powered-by');
    return payload;
  });
}
