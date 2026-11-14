'use client';

import type { PlatformIncidentSummary } from '@univarse/contracts';
import { AlertCircle, ArrowRight, buttonClass, Check, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';
import { clockText, INCIDENT_STATUS, SEVERITY } from '../../lib/incidents';

/**
 * Spec 0037 Q13: what has gone wrong, and what's still going on. Open incidents first, with their severity, status and,
 * when personal data may be involved, the 72-hour clock; then the resolved ones. Everyone who can read institutions
 * reads this; opening and updating are for those who run incidents.
 */
export function IncidentsView() {
  const me = useMe();
  const [rows, setRows] = useState<PlatformIncidentSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const canRead = me.permissions.includes('platform.tenant.read');
  const canRun = me.permissions.includes('platform.incident.manage');

  useEffect(() => {
    if (!canRead) return;
    api<{ data: PlatformIncidentSummary[] }>('GET', '/incidents')
      .then((r) => setRows(r.data))
      .catch((err: unknown) => setError(asApiError(err)));
  }, [canRead]);

  if (!canRead) return <NothingHere />;
  const open = rows?.filter((i) => i.status !== 'RESOLVED') ?? [];
  const resolved = rows?.filter((i) => i.status === 'RESOLVED') ?? [];

  return (
    <section className="pc-section" aria-labelledby="incidents-title">
      <div className="pc-section__head">
        <div>
          <h1 id="incidents-title" className="pc-section__title">
            Incidents
          </h1>
          <p className="pc-section__lead">Each one’s timeline is its record. Institutions see the public text; internal notes stay here.</p>
        </div>
        {canRun ? (
          <Link className={buttonClass()} href="/incidents/new">
            Open an incident
          </Link>
        ) : null}
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {rows === null ? (
        error ? null : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
      ) : (
        <>
          <Group title="Open" rows={open} empty="Nothing is going on." />
          {resolved.length ? <Group title="Resolved" rows={resolved} empty="" /> : null}
        </>
      )}
    </section>
  );
}

function Group({ title, rows, empty }: { title: string; rows: readonly PlatformIncidentSummary[]; empty: string }) {
  const id = `group-${title.toLowerCase()}`;
  return (
    <div className="pc-approvals__group" role="group" aria-labelledby={id}>
      <h2 id={id} className="pc-subhead">
        {title}
        {rows.length ? <span className="pc-count">{rows.length}</span> : null}
      </h2>
      {rows.length === 0 ? (
        <div className="pc-empty pc-inbox__clear">
          <span className="uv-icon-tile">
            <Check />
          </span>
          <p>{empty}</p>
        </div>
      ) : (
        <ul className="pc-list">
          {rows.map((i) => {
            const clock = i.breachDeadline && i.status !== 'RESOLVED' ? clockText(i.breachDeadline) : null;
            return (
              <li key={i.id}>
                <Link className="pc-list__row" href={`/incidents/${i.id}`}>
                  <span className="uv-icon-tile">
                    <AlertCircle />
                  </span>
                  <span className="pc-list__text">
                    <span className="pc-list__title">{i.title}</span>
                    <span className="pc-list__meta">
                      {i.status === 'RESOLVED' ? `Resolved ${when(i.resolvedAt)}` : `Last update ${when(i.lastUpdateAt)}`} · {i.institutions === 1 ? '1 institution' : `${String(i.institutions)} institutions`}
                      {clock ? ` · personal data: ${clock.text}` : ''}
                    </span>
                  </span>
                  <span className={`pc-status ${SEVERITY[i.severity].tone}`}>{SEVERITY[i.severity].label}</span>
                  <span className={`pc-status ${INCIDENT_STATUS[i.status].tone}`}>{INCIDENT_STATUS[i.status].label}</span>
                  <ArrowRight size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
