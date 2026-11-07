// Spec 0031 Q12, Q13: what the security page shows, from the per-minute counts: totals by level, each event, each
// institution, and a series over time. Reading counts isn't audited: they hold nothing about anyone (Q8).
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import type { PlatformOps } from '@univarse/contracts';
import { securityLevel, type SecurityLevel } from '@univarse/domain';
import type { z } from 'zod';
import { NO_TENANT } from '../../shared/observability/security-rollup.js';
import { CONSOLE_DB } from '../platform-config.js';

type Query = z.infer<typeof PlatformOps.security.query>;
type Response = z.infer<typeof PlatformOps.security.response>;
type Counts = Record<SecurityLevel, number>;

const WINDOW_HOURS = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 } as const;
const zero = (): Counts => ({ act: 0, watch: 0, note: 0 });

@Injectable()
export class PlatformSecurityView {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  async summary(q: Query, now = new Date()): Promise<Response> {
    const window = q.window ?? '24h';
    const since = new Date(now.getTime() - WINDOW_HOURS[window] * 3_600_000);
    const bucket = window === '24h' ? 'hour' : 'day';
    const tenant = q.tenantId ?? null;
    const rows = await this.db.$queryRaw<{ at: Date; event: string; tenant_id: string; count: bigint; last_seen_at: Date }[]>`
      SELECT date_trunc(${bucket}, minute) AS at, event, tenant_id, SUM("count")::bigint AS count, MAX(last_seen_at) AS last_seen_at
        FROM platform_security_event_rollup
       WHERE minute >= ${since} AND (${tenant}::uuid IS NULL OR tenant_id = ${tenant}::uuid)
       GROUP BY 1, 2, 3
       ORDER BY 1`;

    const totals = zero();
    const events = new Map<string, { count: number; lastSeenAt: Date }>();
    const institutions = new Map<string, Counts>();
    const series = new Map<number, Counts>();
    for (const r of rows) {
      const n = Number(r.count);
      const level = securityLevel(r.event);
      totals[level] += n;
      const e = events.get(r.event);
      events.set(r.event, { count: (e?.count ?? 0) + n, lastSeenAt: e && e.lastSeenAt > r.last_seen_at ? e.lastSeenAt : r.last_seen_at });
      if (r.tenant_id !== NO_TENANT) {
        const c = institutions.get(r.tenant_id) ?? zero();
        c[level] += n;
        institutions.set(r.tenant_id, c);
      }
      const s = series.get(r.at.getTime()) ?? zero();
      s[level] += n;
      series.set(r.at.getTime(), s);
    }

    const names = await this.db.tenant.findMany({ where: { id: { in: [...institutions.keys()] } }, select: { id: true, slug: true, shortName: true } });
    const named = new Map(names.map((t) => [t.id, t]));
    const order: Record<SecurityLevel, number> = { act: 0, watch: 1, note: 2 };
    return {
      window,
      totals,
      events: [...events]
        .map(([event, e]) => ({ event, level: securityLevel(event), count: e.count, lastSeenAt: e.lastSeenAt.toISOString() }))
        .sort((a, b) => order[a.level] - order[b.level] || b.count - a.count),
      institutions: [...institutions]
        .map(([id, c]) => ({ institution: { id, slug: named.get(id)?.slug ?? null, name: named.get(id)?.shortName ?? null }, ...c }))
        .sort((a, b) => b.act - a.act || b.watch - a.watch || b.note - a.note),
      series: [...series].sort(([a], [b]) => a - b).map(([at, c]) => ({ at: new Date(at).toISOString(), ...c })),
    };
  }
}
