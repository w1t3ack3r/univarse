// Spec 0012 OB2/OB8: who a log line belongs to, carried by AsyncLocalStorage so call sites never pass it.
// OBSERVABILITY ONLY. Nothing may read this for database tenancy or authorization: those keep using the
// explicit tenant context (`req.tenant`, `ShardRegistry.forTenant/tx`) and the loaded actor, as before.
// Each request (and each claimed worker row) gets its OWN store object; fields start as null and are
// filled as they are resolved (TenantGuard: tenant; AccessGuard: user). Tenant and user come only from
// the Host and the session, never from trace headers or baggage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace, type Span } from '@opentelemetry/api';

export interface LogContext {
  requestId: string | null;
  tenantId: string | null;
  userId: string | null;
  /** The request's root span (OB8): tenant.id and user.id are set on it as they're resolved. */
  span?: Span | undefined;
}

const store = new AsyncLocalStorage<LogContext>();

export const currentLogContext = (): LogContext | undefined => store.getStore();

/** Runs `fn` with a fresh context (a request, or one claimed worker row). */
export function withLogContext<T>(initial: Partial<LogContext>, fn: () => T): T {
  const ctx: LogContext = { requestId: null, tenantId: null, userId: null, span: trace.getActiveSpan(), ...initial };
  if (ctx.requestId) ctx.span?.setAttribute('request.id', ctx.requestId);
  if (ctx.tenantId) ctx.span?.setAttribute('tenant.id', ctx.tenantId);
  return store.run(ctx, fn);
}

/** Fills in fields as they become known. Outside a context it does nothing. */
export function setLogContext(patch: Partial<LogContext>): void {
  const ctx = store.getStore();
  if (!ctx) return;
  Object.assign(ctx, patch);
  // The same values on the request's root span, from the same sources (Host, session), never from headers.
  if (patch.tenantId) ctx.span?.setAttribute('tenant.id', patch.tenantId);
  if (patch.userId) ctx.span?.setAttribute('user.id', patch.userId);
}
