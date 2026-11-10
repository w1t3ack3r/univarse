// What the audit and security pages work out, apart from how they draw it.
import type { PlatformSecuritySummary } from '@univarse/contracts';

export interface AuditFilters {
  readonly actionGroup: string;
  readonly actorId: string;
  readonly from: string;
  readonly to: string;
  /** One institution, from its page (spec 0033 Q4). */
  readonly tenantId?: string;
}

/** Dates as staff pick them (`2026-11-07`, a whole day in WAT), as the instants the API takes. */
export function auditQuery(f: AuditFilters, cursor?: string): string {
  const q = new URLSearchParams();
  if (f.actionGroup) q.set('actionGroup', f.actionGroup);
  if (f.actorId) q.set('actorId', f.actorId);
  if (f.tenantId) q.set('tenantId', f.tenantId);
  if (f.from) q.set('from', new Date(`${f.from}T00:00:00+01:00`).toISOString());
  if (f.to) q.set('to', new Date(`${f.to}T23:59:59.999+01:00`).toISOString());
  if (cursor) q.set('cursor', cursor);
  return q.size ? `?${q.toString()}` : '';
}

const n = (v: number) => v.toLocaleString('en-NG');

/** One sentence that answers "does anything need me?", which is why someone opens the page. */
export function securityHeadline({ totals: { act, watch, note } }: Pick<PlatformSecuritySummary, 'totals'>): string {
  if (act > 0) return `${n(act)} ${act === 1 ? 'event needs someone to look at it' : 'events need someone to look at them'}.`;
  if (watch > 0) return `Nothing needs you urgently. ${n(watch)} ${watch === 1 ? 'event is' : 'events are'} worth watching.`;
  if (note > 0) return 'Nothing needs you. A few routine events were recorded.';
  return 'Nothing to report.';
}

type Point = PlatformSecuritySummary['series'][number];

/**
 * Every bucket in the window, so a quiet hour shows as a gap in time, not as a missing one. The API's window starts part
 * way through a bucket (24 hours back from now), so there is one more bucket than the window has hours or days: nothing
 * counted in the totals falls off the chart's left edge.
 */
export function fillSeries(s: Pick<PlatformSecuritySummary, 'window' | 'series'>, now: number): Point[] {
  const hourly = s.window === '24h';
  const step = hourly ? 3_600_000 : 86_400_000;
  const length = hourly ? 25 : s.window === '7d' ? 8 : 31;
  const end = Math.floor(now / step) * step;
  const held = new Map(s.series.map((p) => [new Date(p.at).getTime(), p]));
  return Array.from({ length }, (_, i) => {
    const t = end - (length - 1 - i) * step;
    return held.get(t) ?? { at: new Date(t).toISOString(), act: 0, watch: 0, note: 0 };
  });
}
