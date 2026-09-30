import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../db/db.module.js';

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
  expiresAt: number;
}

// RFC 1123-ish hostname: letters, digits, hyphens, dots. Anything else is rejected before a DB lookup.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Resolves the tenant from the request Host ONLY (docs/02 §7.2 rule 1).
 * Negative results are cached too, so unknown-host floods don't hit the database.
 */
@Injectable()
export class TenantResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly MAX_ENTRIES = 5_000;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async resolveHost(rawHost: string): Promise<TenantContext | null> {
    const host = rawHost.toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(host)) return null;

    const now = Date.now();
    const hit = this.cache.get(host);
    if (hit && hit.expiresAt > now) return hit.value;

    const domain = await this.platform.tenantDomain.findUnique({
      where: { hostname: host },
      include: { tenant: true },
    });
    // Custom domains only count once verified; subdomains are created verified by provisioning.
    const value: TenantContext | null =
      domain && domain.verifiedAt
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

    if (this.cache.size >= TenantResolver.MAX_ENTRIES) this.cache.clear();
    this.cache.set(host, { value, expiresAt: now + this.config.TENANT_CACHE_TTL_MS });
    return value;
  }

  /** Call after lifecycle changes (suspend/resume) so they take effect immediately. */
  invalidate(): void {
    this.cache.clear();
  }
}
