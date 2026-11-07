// Spec 0031 Q8, Q9: security events as per-minute counts, for the console. The logs stay the complete record; this is
// the part the console may read. Attackers trigger these events, so they're counted in memory, capped, and written in
// one statement every 30 seconds: nothing here ever waits on the database inside a request, and a crash loses at most
// 30 seconds of counts that the logs still hold. Only the event's name and its institution are kept.
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { backgroundPass } from './background.js';
import { currentLogContext } from './context.js';
import { setSecurityEventSink, type Service } from './logger.js';
import { SECURITY_EVENTS } from './security.js';

/** Events that belong to no institution: the rollup's key can't hold a NULL. */
export const NO_TENANT = '00000000-0000-0000-0000-000000000000';
export const MAX_ROLLUP_KEYS = 10_000;
const FLUSH_EVERY_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_EVENTS: ReadonlySet<string> = new Set(SECURITY_EVENTS);

export interface RollupRow {
  readonly minute: Date;
  readonly event: string;
  readonly tenantId: string;
  readonly count: number;
  readonly lastSeenAt: Date;
}

/** The buffer: pure, and bounded however many events arrive. */
export class SecurityEventCounts {
  private rows = new Map<string, RollupRow>();
  /** Events not counted because the buffer was full; reported by the next flush. */
  dropped = 0;

  constructor(private readonly maxKeys: number = MAX_ROLLUP_KEYS) {}

  add(event: unknown, tenantId: unknown, at: Date): void {
    if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) return;
    const tenant = typeof tenantId === 'string' && UUID.test(tenantId) ? tenantId.toLowerCase() : NO_TENANT;
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    this.merge({ minute, event, tenantId: tenant, count: 1, lastSeenAt: at });
  }

  private merge(row: RollupRow): void {
    const key = `${String(row.minute.getTime())}|${row.event}|${row.tenantId}`;
    const held = this.rows.get(key);
    if (held) {
      this.rows.set(key, { ...held, count: held.count + row.count, lastSeenAt: held.lastSeenAt > row.lastSeenAt ? held.lastSeenAt : row.lastSeenAt });
    } else if (this.rows.size >= this.maxKeys) {
      this.dropped += row.count;
    } else {
      this.rows.set(key, row);
    }
  }

  /** Everything held, leaving the buffer empty. */
  drain(): RollupRow[] {
    const out = [...this.rows.values()];
    this.rows = new Map();
    return out;
  }

  /** Puts a failed write's rows back, for the next flush; still bounded. */
  restore(rows: readonly RollupRow[]): void {
    for (const r of rows) this.merge(r);
  }
}

/** Which process this is, or null to record nothing: only the real processes set it, never tests or CLI jobs. */
export const SECURITY_ROLLUP_SOURCE = Symbol('SECURITY_ROLLUP_SOURCE');

/** Each process extends this with its own platform client, by `@Inject` (the session-SQL scan sees every client). */
export class SecurityRollupWriter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SecurityRollup');
  readonly counts = new SecurityEventCounts();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: PlatformClient,
    private readonly source: Service | null,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.source) return;
    setSecurityEventSink((event, tenantId) => {
      this.counts.add(event, tenantId ?? currentLogContext()?.tenantId, new Date());
    });
    this.timer = setInterval(() => void backgroundPass(this.logger, 'security.rollup.pass_failed', () => this.flush()), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (!this.source) return;
    setSecurityEventSink(null);
    await backgroundPass(this.logger, 'security.rollup.pass_failed', () => this.flush());
  }

  /** One write of everything held, in one statement. A failed write keeps its rows for the next flush. */
  async flush(): Promise<number> {
    const rows = this.counts.drain();
    const dropped = this.counts.dropped;
    if (dropped > 0) {
      this.counts.dropped = 0;
      this.logger.warn({ event: 'security.rollup.dropped', dropped }, 'Security event counts were dropped: the buffer was full');
    }
    if (rows.length === 0 || !this.source) return 0;
    const source = this.source;
    try {
      await this.db.$executeRaw`
        INSERT INTO platform_security_event_rollup (minute, event, source, tenant_id, "count", last_seen_at)
        SELECT m, e, ${source}, t, c, l
          FROM unnest(${rows.map((r) => r.minute.toISOString())}::timestamptz[], ${rows.map((r) => r.event)}::text[], ${rows.map((r) => r.tenantId)}::uuid[],
                      ${rows.map((r) => r.count)}::int[], ${rows.map((r) => r.lastSeenAt.toISOString())}::timestamptz[]) AS u(m, e, t, c, l)
        ON CONFLICT (minute, event, source, tenant_id) DO UPDATE
          SET "count" = platform_security_event_rollup."count" + EXCLUDED."count",
              last_seen_at = GREATEST(platform_security_event_rollup.last_seen_at, EXCLUDED.last_seen_at)`;
    } catch (err) {
      this.counts.restore(rows);
      throw err;
    }
    return rows.length;
  }
}
