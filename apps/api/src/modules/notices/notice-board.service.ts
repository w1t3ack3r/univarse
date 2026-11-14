// Spec 0037 Q10 (T34): the notices an institution's people see, read by the tenant API from the platform tables
// through column grants (as branding is), with no new credential. Only this host's institution's deliveries are read:
// the tenant comes from the Host, never from the request. Kept per institution for the tenant cache's bound and
// evicted on its invalidation message, which every delivery's arrival or withdrawal sends (spec 0016's capture), so a
// published or withdrawn notice shows or leaves at once without a platform read on every page.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { bannerFor, bannerShows, type NoticeKind } from '@univarse/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { CHANNELS, InvalidationBus } from '../../shared/infra/invalidation-bus.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';

/** The system role the platform's notices call IT Admins (Q10). */
export const IT_ADMIN_ROLE = 'INSTITUTION_ADMIN';

export interface BannerNotice {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly publishedAt: Date;
  readonly shownUntil: Date;
}

interface Entry {
  readonly notices: readonly BannerNotice[];
  readonly expiresAt: number;
}

export interface NoticeBannerView {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly publishedAt: string;
}

const view = (n: BannerNotice): NoticeBannerView => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  startsAt: n.startsAt?.toISOString() ?? null,
  endsAt: n.endsAt?.toISOString() ?? null,
  publishedAt: n.publishedAt.toISOString(),
});

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

@Injectable()
export class NoticeBoard implements OnModuleInit {
  private readonly cache = new Map<string, Entry>();
  private generation = 0;
  private static readonly MAX_ENTRIES = 5_000;

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: InvalidationBus,
    private readonly shards: ShardRegistry,
  ) {}

  onModuleInit(): void {
    this.bus.on(CHANNELS.tenants, (tenantId) => {
      this.generation++;
      this.cache.delete(tenantId);
    });
  }

  /** Q10: what anyone at the institution sees, signed in or not: maintenance only. */
  async forEveryone(tenant: TenantContext, now = new Date()): Promise<NoticeBannerView[]> {
    return (await this.showing(tenant.tenantId, now)).filter((n) => bannerFor(n.kind, false)).map(view);
  }

  /** Q10: what this person sees: maintenance, and for IT Admins the rest; never what they dismissed. */
  async forActor(tenant: TenantContext, actor: Actor, now = new Date()): Promise<NoticeBannerView[]> {
    const shown = await this.visibleTo(tenant, actor, now);
    if (shown.length === 0) return [];
    const dismissed = await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) =>
      tx.noticeDismissal.findMany({ where: { userId: actor.userId, noticeId: { in: shown.map((n) => n.id) } }, select: { noticeId: true } }),
    );
    const hidden = new Set(dismissed.map((d) => d.noticeId));
    return shown.filter((n) => !hidden.has(n.id)).map(view);
  }

  /** Hides a banner for this person. Only a notice shown to them here can be dismissed; anything else is 404. Idempotent. */
  async dismiss(tenant: TenantContext, actor: Actor, noticeId: string, now = new Date()): Promise<void> {
    if (!(await this.visibleTo(tenant, actor, now)).some((n) => n.id === noticeId)) throw notFound();
    await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) =>
      tx.noticeDismissal.createMany({ data: [{ tenantId: tenant.tenantId, userId: actor.userId, noticeId }], skipDuplicates: true }),
    );
  }

  /** Invalidates every institution's entries (tests, and a lifecycle change on this instance). */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
  }

  /** What this person may see here now, dismissed or not. IT Admins are those holding the role, from the loaded grants. */
  private async visibleTo(tenant: TenantContext, actor: Actor, now: Date): Promise<BannerNotice[]> {
    const itAdmin = actor.grants.some((g) => g.roleKey === IT_ADMIN_ROLE);
    return (await this.showing(tenant.tenantId, now)).filter((n) => bannerFor(n.kind, itAdmin));
  }

  /** This institution's published notices whose banners show now, newest first. */
  private async showing(tenantId: string, now: Date): Promise<BannerNotice[]> {
    return (await this.published(tenantId)).filter((n) => bannerShows({ kind: n.kind, shownUntil: n.shownUntil, withdrawn: false }, now));
  }

  private async published(tenantId: string): Promise<readonly BannerNotice[]> {
    const start = performance.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > start) return hit.notices;
    const generation = this.generation;
    const rows = await this.platform.platformNoticeDelivery.findMany({
      where: { tenantId, withdrawnAt: null, notice: { status: 'PUBLISHED' } },
      select: { notice: { select: { id: true, kind: true, title: true, body: true, startsAt: true, endsAt: true, publishedAt: true, shownUntil: true } } },
    });
    const notices: BannerNotice[] = [];
    for (const { notice: n } of rows) {
      if (n.publishedAt && n.shownUntil) notices.push({ ...n, publishedAt: n.publishedAt, shownUntil: n.shownUntil });
    }
    notices.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    // A message during the read means the result may be stale: serve it, never cache it (as the resolver, IO13).
    if (this.generation === generation) {
      if (this.cache.size >= NoticeBoard.MAX_ENTRIES) this.cache.clear();
      this.cache.set(tenantId, { notices, expiresAt: start + this.config.TENANT_CACHE_TTL_MS });
    }
    return notices;
  }
}
