// Unwrapped-DEK cache (spec 0006 E5, E6; spec 0015 CI7). One unwrap per (tenant, version) per TTL; every
// discarded key is zeroed. Concurrent misses for the same key share one provider call.
//
// Spec 0015 CI7 — no stale load, and a hard deadline:
//   • A per-tenant generation. `forget()` bumps it, so a stale in-flight load is never joined. A load that began
//     before a forget never returns or caches its key: the buffer is zeroed and the caller gets a fresh load,
//     which reads the key's status again (a destroyed key then fails).
//   • The deadline is computed from the load's START, so a slow load never extends it. An unwrap that finishes
//     after its deadline is zeroed and discarded, and a fresh load follows.
//   • Each cached key is evicted and zeroed AT its deadline by a timer (unref'd), whether or not it is looked up.
//   • Every removal and zeroing acts on its own entry (identity), never on a newer entry with the same id.
import type { PlatformClient } from '@univarse/db';
import { KeyUnavailableError, wrapContext, type KeyProvider } from './providers.js';

interface Entry {
  readonly key: Buffer;
  readonly expiresAt: number;
  cancel: () => void;
}

interface Load {
  readonly generation: number;
  readonly promise: Promise<Buffer>;
}

/** Schedules `fn` after `ms`; returns a cancel function. Injected in tests. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref();
  return () => clearTimeout(t);
};

export interface KeyringOptions {
  /** ≤ 1 hour (docs/07 §8, spec 0006 E5). */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly schedule?: Schedule;
}

/** The ceiling on every keyring's TTL (docs/07 §8, spec 0006 E5): the latest any process can hold a DEK. */
export const KEYRING_MAX_TTL_MS = 60 * 60_000;

/** How many times a load is restarted after its result was invalidated (forgotten, or past its deadline). */
const MAX_RESTARTS = 2;

export class TenantKeyring {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Load>();
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly schedule: Schedule;

  constructor(
    private readonly platform: PlatformClient,
    private readonly provider: KeyProvider,
    opts: KeyringOptions = {},
  ) {
    this.ttlMs = Math.min(opts.ttlMs ?? KEYRING_MAX_TTL_MS, KEYRING_MAX_TTL_MS);
    this.maxEntries = opts.maxEntries ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** The version new writes must use (E4). Read fresh: rotation takes effect without a restart. */
  async activeVersion(tenantId: string): Promise<number> {
    const row = await this.platform.tenantDataKey.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      select: { version: true },
    });
    if (!row) throw new KeyUnavailableError('no_active_key'); // E11: a programming/provisioning error
    return row.version;
  }

  /**
   * Scoped key ownership for cipher operations (spec 0015, owner review of #66): `fn` gets a PRIVATE copy of the
   * DEK, taken synchronously from a live cache entry, and the copy is zeroed when `fn` settles. Eviction may zero
   * the cached buffer at any moment (that is how a forgotten or expired key leaves memory); it can never reach a
   * copy in use, so no cipher operation ever runs with a zeroed key. Throws KeyUnavailableError (E6).
   */
  async withKey<T>(
    tenantId: string,
    version: number,
    fn: (key: Buffer) => T | Promise<T>,
  ): Promise<T> {
    const id = `${tenantId}:${version}`;
    let copy: Buffer | null = null;
    for (let attempt = 0; attempt <= MAX_RESTARTS + 1 && !copy; attempt++) {
      const hit = this.cache.get(id);
      // Read and copied in the same tick: nothing can evict (and zero) the entry in between.
      if (hit && hit.expiresAt > this.now()) copy = Buffer.from(hit.key);
      // Otherwise load it, then read the CACHE again: the buffer a load returns may already be evicted by the
      // time this continuation runs.
      else await this.key(tenantId, version);
    }
    if (!copy) throw new KeyUnavailableError('provider_unavailable');
    if (copy.every((b) => b === 0)) {
      copy.fill(0);
      throw new KeyUnavailableError('provider_unavailable'); // fail closed: never encrypt under an all-zero key
    }
    try {
      return await fn(copy);
    } finally {
      copy.fill(0);
    }
  }

  /**
   * The CACHED DEK buffer for (tenant, version): cached, or unwrapped once. Throws KeyUnavailableError (E6).
   * Not for cipher operations: eviction can zero this buffer at any moment. Use `withKey`.
   */
  async key(tenantId: string, version: number): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const id = `${tenantId}:${version}`;
      const hit = this.cache.get(id);
      if (hit && hit.expiresAt > this.now()) return hit.key;
      if (hit) this.evict(id, hit);

      const generation = this.generation(tenantId);
      let load = this.inflight.get(id);
      if (!load || load.generation !== generation) {
        const promise = this.load(tenantId, version, generation);
        const record: Load = { generation, promise };
        // Only this load's own record is removed: never a newer load's (CI7, old callbacks).
        void promise.then(
          () => this.inflight.get(id) === record && this.inflight.delete(id),
          () => this.inflight.get(id) === record && this.inflight.delete(id),
        );
        this.inflight.set(id, record);
        load = record;
      }
      const key = await load.promise;
      if (key.length > 0) return key;
      // The load's result was invalidated (forgotten meanwhile, or past its deadline): a fresh load re-reads
      // the key's status. Bounded, so a provider slower than the TTL fails instead of looping.
      if (attempt >= MAX_RESTARTS) throw new KeyUnavailableError('provider_unavailable');
    }
  }

  /**
   * Reads the key's status, unwraps, and caches only if the result is still valid: same generation (no forget
   * meanwhile) and before its deadline (computed from the START of the load). Otherwise the unwrapped buffer is
   * zeroed and an empty buffer is returned, so `key()` starts a fresh load.
   */
  private async load(tenantId: string, version: number, generation: number): Promise<Buffer> {
    const startedAt = this.now();
    const deadline = startedAt + this.ttlMs;
    const row = await this.platform.tenantDataKey.findUnique({
      where: { tenantId_version: { tenantId, version } },
    });
    if (!row) throw new KeyUnavailableError('no_active_key');
    if (row.status === 'DESTROYED' || !row.wrappedDek)
      throw new KeyUnavailableError('key_destroyed');
    const key = await this.provider.unwrap(row.wrappedDek, wrapContext(tenantId, version));
    if (this.generation(tenantId) !== generation || this.now() >= deadline) {
      key.fill(0);
      return Buffer.alloc(0);
    }
    const id = `${tenantId}:${version}`;
    const previous = this.cache.get(id);
    if (previous) this.evict(id, previous);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.entries().next();
      if (!oldest.done) this.evict(oldest.value[0], oldest.value[1]);
    }
    const entry: Entry = { key, expiresAt: deadline, cancel: () => undefined };
    entry.cancel = this.schedule(() => this.evict(id, entry), deadline - this.now());
    this.cache.set(id, entry);
    return key;
  }

  /**
   * Drops (and zeroes) a tenant's cached keys; its in-flight loads become stale (never joined, never cached): after crypto-shredding or
   * rotation, and on a `uv:keys:forget` broadcast (spec 0015 CI5).
   */
  forget(tenantId: string): void {
    this.generations.set(tenantId, this.generation(tenantId) + 1);
    for (const [id, entry] of [...this.cache.entries()])
      if (id.startsWith(`${tenantId}:`)) this.evict(id, entry);
  }

  private generation(tenantId: string): number {
    return this.generations.get(tenantId) ?? 0;
  }

  /** Zeroes and removes `entry`, but only if it is still the cached entry for `id` (never a newer one). */
  private evict(id: string, entry: Entry): void {
    entry.cancel();
    entry.key.fill(0);
    if (this.cache.get(id) === entry) this.cache.delete(id);
  }

  /** For tests: number of cached keys. */
  get size(): number {
    return this.cache.size;
  }
}
