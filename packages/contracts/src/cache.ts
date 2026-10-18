// Spec 0016 D6: the shared maximum lifetime of a tenant cache entry (the products cache and the tenant resolver),
// in milliseconds. Every API and worker instance refuses to start with TENANT_CACHE_TTL_MS above it, and the
// database's public.cache_invalidation_max_ttl() returns the same value (a unit test reads the migration): an
// undelivered invalidation expires only after first observation + this + 5 s, when no cache can still hold the
// pre-change value.
export const MAX_TENANT_CACHE_TTL_MS = 60_000;
