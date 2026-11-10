'use client';

import { AUDIT_ACTION_GROUPS, auditActionLabel, type PlatformAuditLog, type PlatformChainStatus } from '@univarse/contracts';
import { Button, ChevronDown, Notice, ShieldCheck } from '@univarse/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode, type SubmitEvent } from 'react';
import { NothingHere } from '../../components/nothing-here';
import { useMe } from '../../components/console-shell';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';
import { auditQuery, type AuditFilters } from '../../lib/observe';

type Log = PlatformAuditLog;
type Row = Log['data'][number];
type Run = NonNullable<PlatformChainStatus['latest']>;

const NO_FILTERS: AuditFilters = { actionGroup: '', actorId: '', from: '', to: '' };

const actorName = (r: Row) => (r.actor.id === null ? 'The system' : (r.actor.name ?? 'A former staff member'));

/**
 * The audit log (spec 0031 Q2 to Q7): what every staff member and the system did, newest first, and whether the record
 * is intact. Filters apply on the button, not on each change: every new query is itself recorded.
 */
export function AuditView() {
  const me = useMe();
  const canRead = me.permissions.includes('platform.audit.read');
  const tenantId = useSearchParams().get('tenantId') ?? undefined;
  const [draft, setDraft] = useState<AuditFilters>(NO_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>({ ...NO_FILTERS, ...(tenantId ? { tenantId } : {}) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [staff, setStaff] = useState<{ id: string; displayName: string }[]>([]);

  useEffect(() => {
    if (!canRead) return;
    let live = true; // on a slow network an older search can answer after a newer one
    setRows(null);
    setCursor(null);
    setError(null);
    api<Log>('GET', `/audit${auditQuery(filters)}`)
      .then((r) => {
        if (!live) return;
        setRows(r.data);
        setCursor(r.page.nextCursor);
      })
      .catch((err: unknown) => {
        if (live) setError(asApiError(err));
      });
    return () => {
      live = false;
    };
  }, [canRead, filters]);

  useEffect(() => {
    if (!me.permissions.includes('platform.staff.read')) return;
    api<{ data: { id: string; displayName: string }[] }>('GET', '/staff')
      .then((r) => setStaff(r.data))
      .catch(() => undefined); // the filter just lists nobody; the log itself still works
  }, [me.permissions]);

  const loadMore = () => {
    if (!cursor) return;
    setMore(true);
    api<Log>('GET', `/audit${auditQuery(filters, cursor)}`)
      .then((r) => {
        setRows((held) => [...(held ?? []), ...r.data]);
        setCursor(r.page.nextCursor);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setMore(false));
  };

  const apply = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFilters({ ...draft, ...(tenantId ? { tenantId } : {}) });
  };
  const filtering = useMemo(() => Object.values(filters).some(Boolean), [filters]);

  if (!canRead) return <NothingHere />;

  return (
    <section className="pc-section" aria-labelledby="audit-title">
      <div className="pc-section__head">
        <div>
          <h1 id="audit-title" className="pc-section__title">
            Audit log
          </h1>
          <p className="pc-section__lead">
            Everything staff and the system have done on the platform. Each search here is recorded too.
          </p>
        </div>
      </div>

      <ChainStatus canVerify={me.permissions.includes('platform.audit.verify')} />
      {tenantId ? (
        <p className="pc-note">
          Showing one institution.{' '}
          <Link className="uv-link" href="/audit" onClick={() => setFilters(NO_FILTERS)}>
            Show everything
          </Link>
        </p>
      ) : null}

      <form method="get" className="pc-filters" onSubmit={apply}>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="audit-group">
            What
          </label>
          <select id="audit-group" className="uv-field__input pc-select" value={draft.actionGroup} onChange={(e) => setDraft({ ...draft, actionGroup: e.target.value })}>
            <option value="">Everything</option>
            {AUDIT_ACTION_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="audit-actor">
            Who
          </label>
          <select id="audit-actor" className="uv-field__input pc-select" value={draft.actorId} onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}>
            <option value="">Anyone</option>
            {staff.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="audit-from">
            From
          </label>
          <input id="audit-from" type="date" className="uv-field__input" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="audit-to">
            To
          </label>
          <input id="audit-to" type="date" className="uv-field__input" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <div className="pc-filters__go">
          <Button type="submit" variant="quiet">
            Show
          </Button>
        </div>
      </form>

      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {rows === null && !error ? <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" /> : null}
      {rows?.length === 0 ? <p className="pc-empty">{filtering ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}</p> : null}
      {rows && rows.length > 0 ? (
        <ol className="pc-log" aria-label="Audit entries, newest first">
          {rows.map((r) => (
            <LogRow key={r.id} row={r} />
          ))}
        </ol>
      ) : null}
      {cursor ? (
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="button" variant="quiet" pending={more} onClick={loadMore}>
            Show older entries
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function LogRow({ row }: { row: Row }) {
  const details = Object.entries(row.metadata);
  return (
    <li>
      <details className="pc-log__row">
        <summary>
          <span className="pc-log__what">{auditActionLabel(row.action)}</span>
          <span className="pc-log__who">{actorName(row)}</span>
          <time className="pc-log__when" dateTime={row.occurredAt}>
            {when(row.occurredAt)}
          </time>
          <ChevronDown size={18} />
        </summary>
        <dl className="pc-facts">
          <Fact term="Entry">{row.seq}</Fact>
          <Fact term="Recorded as">{row.action}</Fact>
          {row.actor.id ? <Fact term="Staff id">{row.actor.id}</Fact> : null}
          {row.tenant ? <Fact term="Institution">{row.tenant.slug ?? row.tenant.id}</Fact> : null}
          {row.ip ? <Fact term="Address">{row.ip}</Fact> : null}
          {details.map(([k, v]) => (
            <Fact key={k} term={k}>
              {typeof v === 'string' ? v : JSON.stringify(v)}
            </Fact>
          ))}
        </dl>
      </details>
    </li>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const RESULT: Record<Run['status'], string> = { RUNNING: 'Checking', PASSED: 'Intact', FAILED: 'Failed', ERROR: 'Couldn’t finish' };
const TONE: Record<Run['status'], string> = { RUNNING: 'pc-status--wait', PASSED: 'pc-status--on', FAILED: 'pc-status--bad', ERROR: 'pc-status--wait' };
const WHY: Record<string, string> = {
  row_changed: 'an entry was changed',
  row_missing: 'an entry is missing',
  tail_missing: 'the newest entries are missing',
};
const count = (n: string) => Number(n).toLocaleString('en-NG');

function ChainStatus({ canVerify }: { canVerify: boolean }) {
  const [v, setV] = useState<PlatformChainStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [starting, setStarting] = useState(false);
  const again = () => setTick((t) => t + 1);

  // Reads again every 2 seconds only while a run is going, so an idle page costs nothing.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    api<PlatformChainStatus>('GET', '/audit/verification')
      .then((r) => {
        if (!live) return;
        setV(r);
        if (r.latest?.status === 'RUNNING') timer = setTimeout(again, 2_000);
      })
      .catch((err: unknown) => {
        if (live) setError(asApiError(err));
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick]);

  const start = () => {
    setStarting(true);
    setError(null);
    api('POST', '/audit/verification')
      .catch((err: unknown) => setError(asApiError(err))) // already running: show it, and read the run anyway
      .finally(() => {
        setStarting(false);
        again();
      });
  };

  const run = v?.latest ?? null;
  return (
    <div className="pc-chain">
      <span className="uv-icon-tile">
        <ShieldCheck />
      </span>
      <div className="pc-chain__text">
        <p className="pc-chain__state">
          {run ? <span className={`pc-status ${TONE[run.status]}`}>{RESULT[run.status]}</span> : null}
          {run ? null : v ? 'Not checked yet' : 'Loading…'}
        </p>
        {run ? <p className="pc-chain__meta">{describeRun(run)}</p> : <p className="pc-chain__meta">The first check runs by itself within a day, or you can start one.</p>}
      </div>
      {canVerify ? (
        <Button type="button" variant="quiet" pending={starting} disabled={run?.status === 'RUNNING'} onClick={start}>
          Check now
        </Button>
      ) : null}
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
    </div>
  );
}

function describeRun(run: Run): string {
  const rows = count(run.rowsChecked);
  const by = run.startedBy ? (run.startedBy.name ?? 'a former staff member') : 'the daily check';
  if (run.status === 'RUNNING') return `${rows} entries checked so far.`;
  if (run.status === 'PASSED') return `${rows} entries checked by ${by}, ${when(run.finishedAt)}. Nothing has been changed or removed.`;
  if (run.status === 'FAILED') return `Stopped at entry ${run.brokenAtSeq ?? '?'}: ${WHY[run.reason ?? ''] ?? 'an entry doesn’t match'}. ${when(run.finishedAt)}.`;
  return `This check couldn’t finish, ${when(run.finishedAt)}. That says nothing about the log. Try again.`;
}
