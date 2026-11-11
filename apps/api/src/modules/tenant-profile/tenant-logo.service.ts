// Spec 0033 Q11, Q12: an institution's logo, for its own pages. The tenant's cached context carries only the logo's
// hash; the bytes are read once per hash and kept for the tenant cache's bound, so a public page doesn't read the
// platform database on every load. A new logo has a new hash, so it's never served stale past the context's own bound.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../../shared/db/db.module.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';

export interface Logo {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly sha256: string;
}

interface Entry {
  readonly logo: Logo;
  readonly expiresAt: number;
}

@Injectable()
export class TenantLogos {
  private readonly cache = new Map<string, Entry>();
  private static readonly MAX_ENTRIES = 500;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The logo the context names, or null. A row that no longer matches the context's hash is a change in flight. */
  async forTenant(tenant: TenantContext): Promise<Logo | null> {
    if (!tenant.logoSha256) return null;
    const now = performance.now();
    const hit = this.cache.get(tenant.tenantId);
    if (hit && hit.logo.sha256 === tenant.logoSha256 && hit.expiresAt > now) return hit.logo;
    const row = await this.platform.tenantBranding.findUnique({ where: { tenantId: tenant.tenantId }, select: { logo: true, logoMime: true, logoSha256: true } });
    if (!row?.logo || !row.logoMime || !row.logoSha256) return null;
    const logo = { bytes: row.logo, mime: row.logoMime, sha256: row.logoSha256 };
    if (this.cache.size >= TenantLogos.MAX_ENTRIES) this.cache.clear();
    this.cache.set(tenant.tenantId, { logo, expiresAt: now + this.config.TENANT_CACHE_TTL_MS });
    return logo;
  }
}
