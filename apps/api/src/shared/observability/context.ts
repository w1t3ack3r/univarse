// Spec 0012 OB2/OB8: who a log line belongs to, carried by AsyncLocalStorage so call sites never pass it.
// OBSERVABILITY ONLY. Nothing may read this for database tenancy or authorization: those keep using the
// explicit tenant context (`req.tenant`, `ShardRegistry.forTenant/tx`) and the loaded actor, as before.
// Each request (and each claimed worker row) gets its OWN store object; fields start as null and are
// filled as they are resolved (TenantGuard: tenant; AccessGuard: user). Tenant and user come only from
// the Host and the session, never from trace headers or baggage.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId: string | null;
  tenantId: string | null;
  userId: string | null;
}

const store = new AsyncLocalStorage<LogContext>();

export const currentLogContext = (): LogContext | undefined => store.getStore();

/** Runs `fn` with a fresh context (a request, or one claimed worker row). */
export function withLogContext<T>(initial: Partial<LogContext>, fn: () => T): T {
  return store.run({ requestId: null, tenantId: null, userId: null, ...initial }, fn);
}

/** Fills in fields as they become known. Outside a context it does nothing. */
export function setLogContext(patch: Partial<LogContext>): void {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, patch);
}
