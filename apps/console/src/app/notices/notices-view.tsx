'use client';

import type { PlatformNoticeSummary } from '@univarse/contracts';
import { ArrowRight, buttonClass, Clock, Megaphone, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';
import { audienceText, NOTICE_KIND, noticeState } from '../../lib/notices';

/**
 * Spec 0037 Q9: what the platform has told institutions. Showing now first, then drafts, then what has ended or was
 * withdrawn. Everyone who can read institutions can read this; writing is for those who may publish.
 */
export function NoticesView() {
  const me = useMe();
  const [rows, setRows] = useState<PlatformNoticeSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const canRead = me.permissions.includes('platform.tenant.read');
  const canWrite = me.permissions.includes('platform.notice.publish');

  useEffect(() => {
    if (!canRead) return;
    api<{ data: PlatformNoticeSummary[] }>('GET', '/notices')
      .then((r) => setRows(r.data))
      .catch((err: unknown) => setError(asApiError(err)));
  }, [canRead]);

  if (!canRead) return <NothingHere />;
  const showing = rows?.filter((n) => n.live) ?? [];
  const drafts = rows?.filter((n) => n.status === 'DRAFT') ?? [];
  const past = rows?.filter((n) => n.status !== 'DRAFT' && !n.live) ?? [];

  return (
    <section className="pc-section" aria-labelledby="notices-title">
      <div className="pc-section__head">
        <div>
          <h1 id="notices-title" className="pc-section__title">
            Notices
          </h1>
          <p className="pc-section__lead">What UniVarse tells institutions: maintenance to everyone there, announcements and release notes to their IT Admins. Plain text, never changed once published.</p>
        </div>
        {canWrite ? (
          <Link className={buttonClass()} href="/notices/new">
            Write a notice
          </Link>
        ) : null}
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {rows === null ? (
        error ? null : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
      ) : rows.length === 0 ? (
        <p className="pc-empty">No notices yet.{canWrite ? ' Write one to tell institutions about maintenance, a change or a release.' : ''}</p>
      ) : (
        <>
          <Group title="Showing now" rows={showing} empty="Nothing is showing at any institution." />
          {drafts.length ? <Group title="Drafts" rows={drafts} empty="" /> : null}
          {past.length ? <Group title="Ended or withdrawn" rows={past} empty="" /> : null}
        </>
      )}
    </section>
  );
}

function Group({ title, rows, empty }: { title: string; rows: readonly PlatformNoticeSummary[]; empty: string }) {
  const id = `group-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="pc-approvals__group" role="group" aria-labelledby={id}>
      <h2 id={id} className="pc-subhead">
        {title}
        {rows.length ? <span className="pc-count">{rows.length}</span> : null}
      </h2>
      {rows.length === 0 ? (
        <p className="pc-note">{empty}</p>
      ) : (
        <ul className="pc-list">
          {rows.map((n) => {
            const state = noticeState(n);
            return (
              <li key={n.id}>
                <Link className="pc-list__row" href={`/notices/${n.id}`}>
                  <span className="uv-icon-tile">{n.kind === 'MAINTENANCE' ? <Clock /> : <Megaphone />}</span>
                  <span className="pc-list__text">
                    <span className="pc-list__title">{n.title}</span>
                    <span className="pc-list__meta">
                      {NOTICE_KIND[n.kind].label} · {audienceText(n)} · {n.publishedAt ? `published ${when(n.publishedAt)}` : `drafted ${when(n.createdAt)}`}
                    </span>
                  </span>
                  <span className={`pc-status ${state.tone}`}>{state.text}</span>
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
