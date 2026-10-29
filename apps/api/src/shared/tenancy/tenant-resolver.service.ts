import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { hasReservedFirstLabel, isReservedName } from '@univarse/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../db/db.module.js';
import { CHANNELS, InvalidationBus } from '../infra/invalidation-bus.js';

export interface TenantContext {
  readonly tenantId: string;
  readonly shardId: string;
  readonly slug: string;
  readonly shortName: string;
  readonly legalName: string;
  readonly type: string;
  readonly status: string;
}

interface CacheEntry {
  value: TenantContext | null;
  /** performance.now() deadline: load start + TTL (spec 0016 IO12). */
  expiresAt: number;
}

// RFC 1123-ish hostname: letters, digits, hyphens, dots. Anything else is rejected before a DB lookup.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Resolves the tenant from the request Host ONLY (docs/02 §7.2 rule 1).
 * Negative results are cached too, so unknown-host floods don't hit the database.
 *
 * Spec 0016: every committed change to tenant or tenant_domain arrives on `uv:tenants:invalidate` (from the
 * database's capture, via the worker's relay). A message evicts that tenant's entries and every negative entry
 * (D5: a new or newly verified host is negative until then). A global generation, bumped by every message and by
 * invalidate(), guards each lookup: its result, positive or negative, is cached only if the generation is unchanged
 * since it began (IO13), which works before any tenant id is known. Deadlines are monotonic (IO12).
 */
@Injectable()
export class TenantResolver implements OnModuleInit {
  private readonly cache = new Map<string, CacheEntry>();
  private generation = 0;
  private static readonly MAX_ENTRIES = 5_000;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: InvalidationBus,
  ) {}

  onModuleInit(): void {
    this.bus.on(CHANNELS.tenants, (tenantId) => this.evict(tenantId));
  }

  async resolveHost(rawHost: string): Promise<TenantContext | null> {
    const host = rawHost.toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(host)) return null;

    const start = performance.now();
    const hit = this.cache.get(host);
    if (hit && hit.expiresAt > start) return hit.value;

    const generation = this.generation;

    const domain = await this.platform.tenantDomain.findUnique({
      where: { hostname: host },
      include: { tenant: true },
    });
    // Custom domains only count once verified; subdomains are created verified by provisioning. Spec 0027 P2: a reserved
    // name (the console's own, say) never resolves to a tenant, whether it's the tenant's slug or the subdomain's label.
    const reserved = domain !== null && (isReservedName(domain.tenant.slug) || (domain.kind === 'SUBDOMAIN' && hasReservedFirstLabel(host)));
    const value: TenantContext | null =
      domain && domain.verifiedAt && !reserved
        ? {
            tenantId: domain.tenant.id,
            shardId: domain.tenant.shardId,
            slug: domain.tenant.slug,
            shortName: domain.tenant.shortName,
            legalName: domain.tenant.legalName,
            type: domain.tenant.type,
            status: domain.tenant.status,
          }
        : null;

    // A tenants message during the read means the result may be stale (or a stale "unknown"): serve, never cache.
    if (this.generation === generation) {
      if (this.cache.size >= TenantResolver.MAX_ENTRIES) this.cache.clear();
      this.cache.set(host, { value, expiresAt: start + this.config.TENANT_CACHE_TTL_MS });
    }
    return value;
  }

  /** Call after lifecycle changes (suspend/resume) so they take effect immediately. */
  invalidate(): void {
    this.cache.clear();
    this.generation++;
  }

  /** D5: the tenant's entries and every negative entry; bumps the global generation. */
  private evict(tenantId: string): void {
    this.generation++;
    for (const [host, entry] of this.cache)
      if (entry.value === null || entry.value.tenantId === tenantId) this.cache.delete(host);
  }
}
