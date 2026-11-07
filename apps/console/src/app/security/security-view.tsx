'use client';

import { securityEventText, type PlatformSecuritySummary as Summary } from '@univarse/contracts';
import { ChevronDown, Notice } from '@univarse/ui';
import { useEffect, useMemo, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';
import { fillSeries, securityHeadline } from '../../lib/observe';

type Period = Summary['window'];
type Level = 'act' | 'watch' | 'note';
type Point = Summary['series'][number];

const WINDOWS: readonly { readonly value: Period; readonly label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
const LEVELS: readonly { readonly key: Level; readonly label: string }[] = [
  { key: 'act', label: 'Needs someone' },
  { key: 'watch', label: 'Worth watching' },
  { key: 'note', label: 'For the record' },
];

const n = (v: number) => v.toLocaleString('en-NG');

const bucketLabel = (at: string, hourly: boolean) =>
  new Intl.DateTimeFormat('en-NG', hourly ? { hour: 'numeric', hour12: true } : { day: 'numeric', month: 'short' }).format(new Date(at));

/**
 * Security events (spec 0031 Q12, Q13): counts only, never who. It leads with whether anything needs a person, then
 * what happened, when, and where. Each event says what to do about it.
 */
export function SecurityView() {
  const me = useMe();
  const canRead = me.permissions.includes('platform.security.read');
  const [period, setPeriod] = useState<Period>('24h');
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let live = true; // on a slow network an older period can answer after a newer one
    setS(null);
    setError(null);
    api<Summary>('GET', `/security?window=${period}`)
      .then((r) => {
        if (live) setS(r);
      })
      .catch((err: unknown) => {
        if (live) setError(asApiError(err));
      });
    return () => {
      live = false;
    };
  }, [canRead, period]);

  if (!canRead) return <NothingHere />;

  return (
    <section className="pc-section" aria-labelledby="sec-title">
      <div className="pc-section__head">
        <div>
          <h1 id="sec-title" className="pc-section__title">
            Security
          </h1>
          <p className="pc-section__lead">{s ? securityHeadline(s) : 'Counts of what the platform refused or noticed, never who.'}</p>
        </div>
      </div>

      <div className="pc-seg" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button key={w.value} type="button" className="pc-seg__opt" aria-pressed={period === w.value} onClick={() => setPeriod(w.value)}>
            {w.label}
          </button>
        ))}
      </div>

      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {s === null && !error ? <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" /> : null}
      {s ? <Report s={s} /> : null}
    </section>
  );
}

function Report({ s }: { s: Summary }) {
  const points = useMemo(() => fillSeries(s, Date.now()), [s]);
  const quiet = s.totals.act + s.totals.watch + s.totals.note === 0;
  if (quiet) return <p className="pc-empty">No security events in this period.</p>;
  return (
    <>
      <Bars points={points} hourly={s.window === '24h'} />
      <h2 className="pc-subhead">What happened</h2>
      <ul className="pc-events">
        {s.events.map((e) => {
          const text = securityEventText(e.event);
          return (
            <li key={e.event} className="pc-event">
              <span className="pc-level">
                <span className={`pc-legend__key pc-fill--${e.level}`} aria-hidden="true" />
                {LEVELS.find((l) => l.key === e.level)?.label}
              </span>
              <p className="pc-event__label">{text.label}</p>
              <p className="pc-event__count">{n(e.count)}</p>
              <p className="pc-event__todo">{text.todo}</p>
              <p className="pc-event__seen">Last seen {when(e.lastSeenAt)}</p>
            </li>
          );
        })}
      </ul>
      {s.institutions.length > 0 ? (
        <>
          <h2 className="pc-subhead">By institution</h2>
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Institution</th>
                {LEVELS.map((l) => (
                  <th key={l.key} scope="col">
                    {l.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.institutions.map((i) => (
                <tr key={i.institution.id}>
                  <td className="pc-table__strong">{i.institution.name ?? i.institution.slug ?? i.institution.id}</td>
                  <td data-label="Needs someone">{n(i.act)}</td>
                  <td data-label="Worth watching">{n(i.watch)}</td>
                  <td data-label="For the record">{n(i.note)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

/** Stacked bars over time. Bars are drawn in HTML, so a phone gets no chart library, and each is its own hover target. */
function Bars({ points, hourly }: { points: readonly Point[]; hourly: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const totals = points.map((p) => p.act + p.watch + p.note);
  const max = Math.max(...totals, 1);
  const shown = active === null ? null : points[active];
  const label = `Security events over time, at most ${n(max)} in one ${hourly ? 'hour' : 'day'}. The table below the chart holds every value.`;
  return (
    <figure className="pc-chart">
      <ul className="pc-legend" aria-label="Key">
        {LEVELS.map((l) => (
          <li key={l.key}>
            <span className={`pc-legend__key pc-fill--${l.key}`} aria-hidden="true" />
            {l.label}
          </li>
        ))}
      </ul>
      <div className="pc-chart__plot" role="img" aria-label={label} onPointerLeave={() => setActive(null)}>
        <span className="pc-chart__max">{n(max)}</span>
        <div className="pc-chart__bars">
          {points.map((p, i) => (
            <div key={p.at} className="pc-chart__slot" data-active={active === i ? 'true' : undefined} onPointerEnter={() => setActive(i)}>
              <div className="pc-chart__bar" style={{ height: `${String((totals[i] ?? 0) === 0 ? 0 : Math.max(((totals[i] ?? 0) / max) * 100, 3))}%` }}>
                {LEVELS.map((l) => (p[l.key] > 0 ? <span key={l.key} className={`pc-fill--${l.key}`} style={{ flexGrow: p[l.key] }} /> : null))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="pc-chart__axis" aria-hidden="true">
        <span>{points[0] ? bucketLabel(points[0].at, hourly) : ''}</span>
        <span>{points.at(-1) ? (hourly ? 'Now' : 'Today') : ''}</span>
      </div>
      <p className="pc-chart__readout" aria-hidden="true">
        {shown ? (
          <>
            <strong>{bucketLabel(shown.at, hourly)}</strong>
            {LEVELS.map((l) => (
              <span key={l.key}>
                {n(shown[l.key])} {l.label.toLowerCase()}
              </span>
            ))}
          </>
        ) : (
          'Point at a bar, or open the table.'
        )}
      </p>
      <details className="pc-disclosure">
        <summary className="uv-link">
          See these as a table
          <ChevronDown size={18} />
        </summary>
        <div className="pc-disclosure__body">
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">{hourly ? 'Hour' : 'Day'}</th>
                {LEVELS.map((l) => (
                  <th key={l.key} scope="col">
                    {l.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.filter((_, i) => (totals[i] ?? 0) > 0).map((p) => (
                <tr key={p.at}>
                  <td className="pc-table__strong">{bucketLabel(p.at, hourly)}</td>
                  <td data-label="Needs someone">{n(p.act)}</td>
                  <td data-label="Worth watching">{n(p.watch)}</td>
                  <td data-label="For the record">{n(p.note)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
