// Unwrapped-DEK cache (spec 0006 E5, E6). One unwrap per (tenant, version) per TTL; evicted keys are
// zeroed. Concurrent misses for the same key share one provider call.
import type { PlatformClient } from '@univarse/db';
import { KeyUnavailableError, wrapContext, type KeyProvider } from './providers.js';

interface Entry {
  readonly key: Buffer;
  readonly expiresAt: number;
}

export interface KeyringOptions {
  /** ≤ 1 hour (docs/07 §8). */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class TenantKeyring {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly platform: PlatformClient,
    private readonly provider: KeyProvider,
    opts: KeyringOptions = {},
  ) {
    this.ttlMs = Math.min(opts.ttlMs ?? 60 * 60_000, 60 * 60_000);
    this.maxEntries = opts.maxEntries ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  /** The version new writes must use (E4). Read fresh: rotation takes effect without a restart. */
  async activeVersion(tenantId: string): Promise<number> {
    const row = await this.platform.tenantDataKey.findFirst({ where: { tenantId, status: 'ACTIVE' }, select: { version: true } });
    if (!row) throw new KeyUnavailableError('no_active_key'); // E11: a programming/provisioning error
    return row.version;
  }

  /** The DEK for (tenant, version): cached, or unwrapped once. Throws KeyUnavailableError (E6). */
  async key(tenantId: string, version: number): Promise<Buffer> {
    const id = `${tenantId}:${version}`;
    const hit = this.cache.get(id);
    if (hit && hit.expiresAt > this.now()) return hit.key;
    if (hit) this.evict(id);

    const pending = this.inflight.get(id);
    if (pending) return pending;
    const load = this.load(tenantId, version).finally(() => this.inflight.delete(id));
    this.inflight.set(id, load);
    return load;
  }

  private async load(tenantId: string, version: number): Promise<Buffer> {
    const row = await this.platform.tenantDataKey.findUnique({ where: { tenantId_version: { tenantId, version } } });
    if (!row) throw new KeyUnavailableError('no_active_key');
    if (row.status === 'DESTROYED' || !row.wrappedDek) throw new KeyUnavailableError('key_destroyed');
    const key = await this.provider.unwrap(row.wrappedDek, wrapContext(tenantId, version));
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }
    this.cache.set(`${tenantId}:${version}`, { key, expiresAt: this.now() + this.ttlMs });
    return key;
  }

  /** Drops (and zeroes) a tenant's cached keys, e.g. after crypto-shredding or rotation. */
  forget(tenantId: string): void {
    for (const id of [...this.cache.keys()]) if (id.startsWith(`${tenantId}:`)) this.evict(id);
  }

  private evict(id: string): void {
    this.cache.get(id)?.key.fill(0);
    this.cache.delete(id);
  }

  /** For tests: number of cached keys. */
  get size(): number {
    return this.cache.size;
  }
}
