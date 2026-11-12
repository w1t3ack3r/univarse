'use client';

import type { PlatformTenantList } from '@univarse/contracts';
import { Button, buttonClass, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../lib/api';
import { STATUS, TYPE } from './labels';

type Row = PlatformTenantList['data'][number];

/**
 * Spec 0033 Q2, Q8: every institution, by name. The header's search lands here, and what's searched for stays in the
 * address, so a result can be reloaded or shared with another staff member. An institution's name is nobody's
 * personal data.
 */
export function InstitutionsView() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const canRead = me.permissions.includes('platform.tenant.read');
  const q = params.get('q') ?? '';
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const query = (after?: string) => {
    const s = new URLSearchParams();
    if (q.length >= 2) s.set('q', q);
    if (status) s.set('status', status);
    if (type) s.set('type', type);
    if (after) s.set('cursor', after);
    return s.size ? `?${s.toString()}` : '';
  };

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    setRows(null);
    setCursor(null);
    setError(null);
    api<PlatformTenantList>('GET', `/tenants${query()}`)
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
    // `query` reads exactly these three.
  }, [canRead, q, status, type]);

  const loadMore = () => {
    if (!cursor) return;
    setMore(true);
    api<PlatformTenantList>('GET', `/tenants${query(cursor)}`)
      .then((r) => {
        setRows((held) => [...(held ?? []), ...r.data]);
        setCursor(r.page.nextCursor);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setMore(false));
  };

  if (!canRead) return <NothingHere />;

  const filtering = q.length >= 2 || status !== '' || type !== '';
  return (
    <section className="pc-section" aria-labelledby="inst-title">
      <div className="pc-section__head">
        <div>
          <h1 id="inst-title" className="pc-section__title">
            Institutions
          </h1>
          <p className="pc-section__lead">
            {q.length >= 2 ? (
              <>
                Results for <strong>{q}</strong>.{' '}
                <button type="button" className="uv-link pc-inline-button" onClick={() => router.push('/institutions')}>
                  Clear the search
                </button>
              </>
            ) : (
              'Every institution on the platform, by name.'
            )}
          </p>
        </div>
        {me.permissions.includes('platform.tenant.provision') ? (
          <Link className={buttonClass('action')} href="/institutions/new">
            New institution
          </Link>
        ) : null}
      </div>

      <div className="pc-filters pc-filters--narrow">
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="inst-status">
            Status
          </label>
          <select id="inst-status" className="uv-field__input pc-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {Object.entries(STATUS).map(([value, s]) => (
              <option key={value} value={value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="inst-type">
            Type
          </label>
          <select id="inst-type" className="uv-field__input pc-select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any type</option>
            {Object.entries(TYPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {rows === null && !error ? <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" /> : null}
      {rows?.length === 0 ? <p className="pc-empty">{filtering ? 'No institution matches this.' : 'No institutions yet.'}</p> : null}
      {rows && rows.length > 0 ? (
        <table className="pc-table">
          <thead>
            <tr>
              <th scope="col">Institution</th>
              <th scope="col">Subdomain</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const s = STATUS[t.status];
              return (
                <tr key={t.id}>
                  <td>
                    <Link className="uv-link pc-table__strong" href={`/institutions/${t.id}`}>
                      {t.legalName}
                    </Link>
                  </td>
                  <td data-label="Subdomain">{t.slug}</td>
                  <td data-label="Type">{TYPE[t.type] ?? t.type}</td>
                  <td data-label="Status">
                    <span className={`pc-status ${s?.tone ?? 'pc-status--wait'}`}>{s?.label ?? t.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {cursor ? (
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="button" variant="quiet" pending={more} onClick={loadMore}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
