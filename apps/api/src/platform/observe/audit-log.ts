// Spec 0031 Q2, Q3, Q4: reading the platform audit chain. Newest first, a page at a time, with the row's id as the
// cursor. Names come from a join at read time, because the chain itself holds ids only. A new query is audited in the
// same transaction as its read; following a cursor isn't.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { DEFAULT_PAGE_LIMIT, type PlatformOps } from '@univarse/contracts';
import type { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

type Query = z.infer<typeof PlatformOps.audit.query>;
type Response = z.infer<typeof PlatformOps.audit.response>;

const badCursor = () => new ProblemError(400, 'request.invalid', 'Invalid cursor');

/** A group matches itself and everything under it: `platform.auth` holds `platform.auth.failed`, never `platform.authors`. */
const actionFilter = (q: Query) => {
  if (q.action) return { action: q.action };
  if (q.actionGroup) return { OR: [{ action: q.actionGroup }, { action: { startsWith: `${q.actionGroup}.` } }] };
  return {};
};

@Injectable()
export class PlatformAuditLog {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  async list(actor: PlatformActor, q: Query, meta: RequestMeta): Promise<Response> {
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    return this.db.$transaction(async (tx) => {
      const before = q.cursor ? await this.seqOfCursor(tx, q.cursor) : null;
      if (!q.cursor) {
        const { cursor: _c, limit: _l, ...filters } = q;
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.audit.viewed', metadata: { filters } }, meta);
      }
      const rows = await tx.platformAuditEvent.findMany({
        where: {
          ...actionFilter(q),
          ...(q.actorId ? { actorId: q.actorId } : {}),
          ...(q.tenantId ? { tenantId: q.tenantId } : {}),
          ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
          ...(before === null ? {} : { seq: { lt: before } }),
        },
        orderBy: { seq: 'desc' },
        take: limit + 1,
        select: { id: true, seq: true, occurredAt: true, action: true, actorId: true, tenantId: true, ip: true, metadata: true },
      });
      const page = rows.slice(0, limit);
      const [names, slugs] = await Promise.all([this.memberNames(tx, page), this.tenantSlugs(tx, page)]);
      const last = page.at(-1);
      const hasMore = rows.length > limit;
      return {
        data: page.map((r) => ({
          id: r.id,
          seq: r.seq.toString(),
          occurredAt: r.occurredAt.toISOString(),
          action: r.action,
          actor: { id: r.actorId, name: r.actorId ? (names.get(r.actorId) ?? null) : null },
          tenant: r.tenantId ? { id: r.tenantId, slug: slugs.get(r.tenantId) ?? null } : null,
          ip: r.ip,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
        })),
        page: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, limit, hasMore },
      };
    });
  }

  private async seqOfCursor(tx: PlatformTx, cursor: string): Promise<bigint> {
    const id = decodeCursor(cursor);
    if (!id) throw badCursor();
    const row = await tx.platformAuditEvent.findUnique({ where: { id }, select: { seq: true } });
    if (!row) throw badCursor();
    return row.seq;
  }

  private async memberNames(tx: PlatformTx, rows: readonly { actorId: string | null }[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
    if (ids.length === 0) return new Map();
    const found = await tx.platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
    return new Map(found.map((u) => [u.id, u.displayName]));
  }

  private async tenantSlugs(tx: PlatformTx, rows: readonly { tenantId: string | null }[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.tenantId ? [r.tenantId] : [])))];
    if (ids.length === 0) return new Map();
    const found = await tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
    return new Map(found.map((t) => [t.id, t.slug]));
  }
}
