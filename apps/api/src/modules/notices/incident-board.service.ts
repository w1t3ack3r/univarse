// Spec 0037 Q14: the incidents an institution's people see, read by the tenant API from the platform tables through
// column grants: the title, status and times, and the latest update's public text. Never an internal note, the
// follow-up or the personal-data flag: this role can't read them. Only this host's institution's rows are read (the
// tenant comes from the Host). Kept per institution for the tenant cache's bound and evicted on its invalidation
// message, which every affected-institution row's arrival or touch sends, so a new update shows at once.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { incidentShows, type IncidentStatus } from '@univarse/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../../shared/db/db.module.js';
import { CHANNELS, InvalidationBus } from '../../shared/infra/invalidation-bus.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';

export interface IncidentBannerView {
  readonly id: string;
  readonly title: string;
  readonly status: IncidentStatus;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly latest: { readonly text: string; readonly at: string };
}

interface Row {
  readonly id: string;
  readonly title: string;
  readonly status: IncidentStatus;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly latest: { readonly text: string; readonly at: Date };
}

@Injectable()
export class IncidentBoard implements OnModuleInit {
  private readonly cache = new Map<string, { rows: readonly Row[]; expiresAt: number }>();
  private generation = 0;
  private static readonly MAX_ENTRIES = 5_000;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: InvalidationBus,
  ) {}

  onModuleInit(): void {
    this.bus.on(CHANNELS.tenants, (tenantId) => {
      this.generation++;
      this.cache.delete(tenantId);
    });
  }

  /** Q14: open incidents, and those resolved in the last day, most recently updated first. */
  async forTenant(tenant: TenantContext, now = new Date()): Promise<IncidentBannerView[]> {
    return (await this.rows(tenant.tenantId))
      .filter((r) => incidentShows(r, now))
      .map((r) => ({ id: r.id, title: r.title, status: r.status, startedAt: r.startedAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null, latest: { text: r.latest.text, at: r.latest.at.toISOString() } }));
  }

  invalidate(): void {
    this.generation++;
    this.cache.clear();
  }

  private async rows(tenantId: string): Promise<readonly Row[]> {
    const start = performance.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > start) return hit.rows;
    const generation = this.generation;
    const affected = await this.platform.platformIncidentTenant.findMany({
      where: { tenantId },
      select: {
        incident: {
          select: {
            id: true,
            title: true,
            status: true,
            startedAt: true,
            resolvedAt: true,
            updates: { select: { publicText: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    const rows: Row[] = [];
    for (const { incident: i } of affected) {
      const u = i.updates[0];
      if (u) rows.push({ id: i.id, title: i.title, status: i.status, startedAt: i.startedAt, resolvedAt: i.resolvedAt, latest: { text: u.publicText, at: u.createdAt } });
    }
    rows.sort((a, b) => b.latest.at.getTime() - a.latest.at.getTime());
    if (this.generation === generation) {
      if (this.cache.size >= IncidentBoard.MAX_ENTRIES) this.cache.clear();
      this.cache.set(tenantId, { rows, expiresAt: start + this.config.TENANT_CACHE_TTL_MS });
    }
    return rows;
  }
}
