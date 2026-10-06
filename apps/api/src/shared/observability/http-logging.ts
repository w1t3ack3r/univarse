// Spec 0012 OB2/OB3: every request runs inside its own log context, and ends with ONE summary line.
import type { FastifyInstance } from 'fastify';
import type { Logger as Pino } from 'pino';
import { withLogContext } from './context.js';

/**
 * Starts the request's context (requestId known; tenant and user null until the guards resolve them).
 * Registered first, so every later hook, guard and handler runs inside it.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    withLogContext({ requestId: req.id }, done);
  });
}

/**
 * OB3: method, ROUTE TEMPLATE (never the raw URL: no ids, no query string), status and duration.
 * Severity by outcome (D5): info for 2xx–4xx whoever is signed in, error for 5xx; health probes debug.
 * Security events are logged separately, at warn, by the code that detects them.
 */
export function registerRequestSummary(app: FastifyInstance, log: Pino): void {
  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.url ?? null; // null: no route matched (404)
    const status = reply.statusCode;
    const level = route?.startsWith('/health/') ? 'debug' : status >= 500 ? 'error' : 'info';
    log[level](
      { event: 'http.request', module: 'http', method: req.method, route, status, durationMs: Math.round(reply.elapsedTime) },
      `${req.method} ${route ?? '(no route)'} ${String(status)}`,
    );
    done();
  });
}
