// Spec 0037 Q9, Q10 (E12, T34): notices to institutions, from the console. A notice is drafted, then published once:
// publishing checks it again, decides its audience from the registry as it is then (a delivery row per institution)
// and fixes it for good. Withdrawing marks every delivery, and each delivery's change invalidates that institution's
// cache (spec 0016's capture), so its banner leaves at once. The text is stored as written and is only ever shown as
// text; who may see a banner is decided at the institution (the tenant API), never from anything in the request.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformNotice, PlatformNoticeDraft, PlatformNoticeSummary } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { audienceOf, bannerShows, noticeProblems, shownUntil, type NoticeDraft, type ReleaseRing } from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { stale } from '../../shared/http/etag.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const notDraft = () => new ProblemError(409, 'notice.not_draft', 'Not a draft');
export const TENANT_NOTICES = 10;

const WHO = { select: { id: true, displayName: true } } as const;
const VIEW = {
  id: true,
  kind: true,
  title: true,
  body: true,
  audience: true,
  ring: true,
  tenantIds: true,
  startsAt: true,
  endsAt: true,
  status: true,
  createdAt: true,
  publishedAt: true,
  shownUntil: true,
  withdrawnAt: true,
  version: true,
  author: WHO,
  publisher: WHO,
  withdrawer: WHO,
  _count: { select: { deliveries: true } },
} as const;

type Row = {
  id: string;
  kind: NoticeDraft['kind'];
  title: string;
  audience: NoticeDraft['audience'];
  ring: ReleaseRing | null;
  status: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';
  tenantIds: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  publishedAt: Date | null;
  shownUntil: Date | null;
  withdrawnAt: Date | null;
  _count: { deliveries: number };
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const draftOf = (r: { kind: NoticeDraft['kind']; title: string; body: string; audience: NoticeDraft['audience']; ring: ReleaseRing | null; tenantIds: string[]; startsAt: Date | null; endsAt: Date | null }): NoticeDraft => ({
  kind: r.kind,
  title: r.title,
  body: r.body,
  audience: r.audience,
  ring: r.ring,
  tenantIds: r.tenantIds,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
});

function live(r: Pick<Row, 'status' | 'kind' | 'shownUntil' | 'withdrawnAt'>, now: Date): boolean {
  return r.status === 'PUBLISHED' && r.shownUntil !== null && bannerShows({ kind: r.kind, shownUntil: r.shownUntil, withdrawn: r.withdrawnAt !== null }, now);
}

function summary(r: Row, now: Date): PlatformNoticeSummary {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    audience: r.audience,
    ring: r.ring,
    status: r.status,
    live: live(r, now),
    startsAt: iso(r.startsAt),
    endsAt: iso(r.endsAt),
    createdAt: r.createdAt.toISOString(),
    publishedAt: iso(r.publishedAt),
    shownUntil: iso(r.shownUntil),
    // Before publishing, the institutions chosen by hand; after, those it reached.
    institutions: r.status === 'DRAFT' ? (r.audience === 'TENANTS' ? r.tenantIds.length : 0) : r._count.deliveries,
  };
}

/** What the draft body says, as columns. Text is kept exactly as written (trimmed): it's shown as text, never markup. */
function columns(body: PlatformNoticeDraft) {
  return {
    kind: body.kind,
    title: body.title.trim(),
    body: body.body.trim(),
    audience: body.audience,
    ring: body.audience === 'RING' ? (body.ring ?? null) : null,
    tenantIds: body.audience === 'TENANTS' ? [...new Set(body.tenantIds ?? [])] : [],
    startsAt: body.kind === 'MAINTENANCE' && body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.kind === 'MAINTENANCE' && body.endsAt ? new Date(body.endsAt) : null,
  };
}

@Injectable()
export class PlatformNotices {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  async list(status: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN' | undefined, now = new Date()): Promise<{ data: PlatformNoticeSummary[] }> {
    const rows = await this.db.platformNotice.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      select: VIEW,
    });
    return { data: rows.map((r) => summary(r, now)) };
  }

  async get(id: string, now = new Date()): Promise<PlatformNotice> {
    const r = await this.db.platformNotice.findUnique({ where: { id }, select: VIEW });
    if (!r) throw notFound();
    const [chosen, deliveries] = await Promise.all([
      r.tenantIds.length ? this.db.tenant.findMany({ where: { id: { in: r.tenantIds } }, select: { id: true, slug: true, shortName: true }, orderBy: { shortName: 'asc' } }) : [],
      this.db.platformNoticeDelivery.findMany({
        where: { noticeId: id },
        select: {
          withdrawnAt: true,
          itAdmins: true,
          emailsQueued: true,
          emailsSent: true,
          emailsFailed: true,
          bannersDismissed: true,
          countedAt: true,
          tenant: { select: { id: true, slug: true, shortName: true } },
        },
        orderBy: { tenant: { shortName: 'asc' } },
      }),
    ]);
    const ref = (t: { id: string; slug: string; shortName: string }) => ({ id: t.id, slug: t.slug, name: t.shortName });
    return {
      ...summary(r, now),
      body: r.body,
      tenants: chosen.map(ref),
      createdBy: { id: r.author.id, name: r.author.displayName },
      publishedBy: r.publisher ? { id: r.publisher.id, name: r.publisher.displayName } : null,
      withdrawnBy: r.withdrawer ? { id: r.withdrawer.id, name: r.withdrawer.displayName } : null,
      withdrawnAt: iso(r.withdrawnAt),
      version: r.version,
      problems: r.status === 'DRAFT' ? noticeProblems(draftOf(r), now).map(([path, code]) => ({ path, code })) : [],
      deliveries: deliveries.map((d) => ({
        tenant: ref(d.tenant),
        withdrawnAt: iso(d.withdrawnAt),
        itAdmins: d.itAdmins,
        emailsQueued: d.emailsQueued,
        emailsSent: d.emailsSent,
        emailsFailed: d.emailsFailed,
        bannersDismissed: d.bannersDismissed,
        countedAt: iso(d.countedAt),
      })),
    };
  }

  /** A new draft. It may be unfinished: publishing is where the rules are enforced. */
  async create(actor: PlatformActor, body: PlatformNoticeDraft, meta: RequestMeta): Promise<PlatformNotice> {
    const c = columns(body);
    this.storable(c);
    const id = await this.db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform_notice (kind, title, body, audience, ring, tenant_ids, starts_at, ends_at, created_by, updated_at)
        VALUES (${c.kind}::"NoticeKind", ${c.title}, ${c.body}, ${c.audience}::"NoticeAudience", ${c.ring}::"ReleaseRing",
                ${c.tenantIds}::uuid[], ${c.startsAt}, ${c.endsAt}, ${actor.userId}::uuid, now())
        RETURNING id::text`;
      if (!row) throw new Error('platform_notice insert returned nothing');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.notice.drafted', metadata: { noticeId: row.id, kind: c.kind } }, meta);
      return row.id;
    });
    return this.get(id);
  }

  /** A draft's new text, under `If-Match`. A published or withdrawn notice never changes (the trigger, too). */
  /** A draft's edits aren't consequential: only its publishing is audited, with what it said. */
  async update(id: string, expected: number, body: PlatformNoticeDraft): Promise<PlatformNotice> {
    const c = columns(body);
    this.storable(c);
    await this.db.$transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status !== 'DRAFT') throw notDraft();
      if (r.version !== expected) throw stale();
      await tx.platformNotice.update({ where: { id }, data: { ...c, version: { increment: 1 } }, select: { id: true } });
    });
    return this.get(id);
  }

  /**
   * Q9: checks the draft again, decides its audience from the registry now, and fixes both. Each delivery row's insert
   * invalidates its institution's cache, so the banner shows at once.
   */
  async publish(actor: PlatformActor, id: string, expected: number, meta: RequestMeta, now = new Date()): Promise<PlatformNotice> {
    await this.db.$transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status !== 'DRAFT') throw notDraft();
      if (r.version !== expected) throw stale();
      const problems = noticeProblems(draftOf(r), now);
      if (problems.length) {
        throw Object.assign(new ProblemError(422, 'notice.not_ready', 'Not ready to publish'), { errors: problems.map(([path, code]) => ({ path, code, message: code })) });
      }
      const tenants = await tx.tenant.findMany({ select: { id: true, status: true, releaseRing: true } });
      const reached = audienceOf(r, tenants.map((t) => ({ id: t.id, status: t.status, releaseRing: t.releaseRing })));
      if (reached.length === 0) throw new ProblemError(422, 'notice.no_audience', 'No institution would get it');
      const until = shownUntil(r.kind, now, r.endsAt);
      await tx.platformNotice.update({
        where: { id },
        data: { status: 'PUBLISHED', publishedAt: now, publishedBy: actor.userId, shownUntil: until, version: { increment: 1 } },
        select: { id: true },
      });
      // Raw and by column: the console role inserts only these (the migration's grant).
      await tx.$executeRaw`INSERT INTO platform_notice_delivery (notice_id, tenant_id) SELECT ${id}::uuid, unnest(${reached}::uuid[])`;
      // What was published, by its kind, audience and size; the text stays on the notice's row (it never changes).
      await platformAudit(
        tx,
        { actorId: actor.userId, action: 'platform.notice.published', metadata: { noticeId: id, kind: r.kind, audience: r.audience, ring: r.ring, institutions: reached.length, shownUntil: until.toISOString() } },
        meta,
      );
    });
    return this.get(id);
  }

  /** Q9: a published notice leaves every institution at once; a draft is discarded. Either is final. */
  async withdraw(actor: PlatformActor, id: string, meta: RequestMeta, now = new Date()): Promise<PlatformNotice> {
    await this.db.$transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status === 'WITHDRAWN') throw new ProblemError(409, 'notice.already_withdrawn', 'Already withdrawn');
      await tx.platformNotice.update({ where: { id }, data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnBy: actor.userId, version: { increment: 1 } }, select: { id: true } });
      if (r.status === 'PUBLISHED') {
        const n = await tx.platformNoticeDelivery.updateMany({ where: { noticeId: id, withdrawnAt: null }, data: { withdrawnAt: now } });
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.notice.withdrawn', metadata: { noticeId: id, institutions: n.count } }, meta);
      } else {
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.notice.discarded', metadata: { noticeId: id } }, meta);
      }
    });
    return this.get(id);
  }

  /** Spec 0037 Q11: an institution's notices, newest first, for its detail page. */
  async forTenant(tenantId: string, now = new Date()) {
    const rows = await this.db.platformNoticeDelivery.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: TENANT_NOTICES,
      select: { withdrawnAt: true, notice: { select: { id: true, kind: true, title: true, status: true, publishedAt: true, shownUntil: true, withdrawnAt: true } } },
    });
    return rows
      .filter((d) => d.notice.publishedAt !== null)
      .map((d) => ({
        id: d.notice.id,
        kind: d.notice.kind,
        title: d.notice.title,
        publishedAt: (d.notice.publishedAt ?? now).toISOString(),
        live: live({ ...d.notice, withdrawnAt: d.withdrawnAt ?? d.notice.withdrawnAt }, now),
        withdrawnAt: iso(d.withdrawnAt),
      }));
  }

  /** Locks the notice for this change, or 404. */
  private async locked(tx: PlatformTx, id: string) {
    const [lock] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM platform_notice WHERE id = ${id}::uuid FOR UPDATE`;
    if (!lock) throw notFound();
    return tx.platformNotice.findUniqueOrThrow({
      where: { id },
      select: { id: true, kind: true, title: true, body: true, audience: true, ring: true, tenantIds: true, startsAt: true, endsAt: true, status: true, version: true },
    });
  }

  /** What even a draft must hold to be stored at all: the database's own limits (the full rules wait for publishing). */
  private storable(c: ReturnType<typeof columns>): void {
    const errors: { path: string; code: string; message: string }[] = [];
    if (c.title.length < 1 || c.title.length > 120) errors.push({ path: 'title', code: 'title_length', message: 'title_length' });
    if (c.body.length < 1 || c.body.length > 2_000) errors.push({ path: 'body', code: 'body_length', message: 'body_length' });
    if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) errors.push({ path: 'endsAt', code: 'window_order', message: 'window_order' });
    if (errors.length) throw Object.assign(new ProblemError(422, 'notice.not_ready', 'Not storable'), { errors });
  }
}
