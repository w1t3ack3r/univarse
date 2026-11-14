'use client';

import type { PlatformNotice } from '@univarse/contracts';
import { ArrowLeft, Button, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { useStepUp } from '../../../components/step-up';
import { api, ApiError, asApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { audienceText, NOTICE_KIND, noticeState } from '../../../lib/notices';
import { BannerPreview, NoticeEditor } from '../notice-editor';

/**
 * Spec 0037 Q9, Q11: one notice. A draft opens in the editor (for those who may publish). A published one is a record:
 * what it said, exactly as shown, who published it and when, the institutions it reached, and Withdraw, which takes its
 * banner down everywhere at once.
 */
export function NoticeView() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const stepUp = useStepUp();
  const [n, setN] = useState<PlatformNotice | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const canRead = me.permissions.includes('platform.tenant.read');
  const canWrite = me.permissions.includes('platform.notice.publish');

  const load = useCallback(() => {
    api<PlatformNotice>('GET', `/notices/${id}`)
      .then(setN)
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setMissing(true);
        else setError(asApiError(err));
      });
  }, [id]);
  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  if (!canRead || missing) return <NothingHere />;
  if (!n) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />;

  const state = noticeState(n);
  const withdraw = () => {
    setBusy(true);
    setError(null);
    stepUp(() => api<PlatformNotice>('POST', `/notices/${n.id}/withdraw`))
      .then((r) => {
        if (!r) return;
        setN(r);
        setDone('Withdrawn. Its banner has left every institution.');
      })
      .catch((err: unknown) => {
        setError(asApiError(err));
        load();
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="pc-section" aria-labelledby="notice-title">
      <Link className="uv-link pc-back" href="/notices">
        <ArrowLeft size={18} />
        Notices
      </Link>
      <div className="pc-section__head">
        <div>
          <h1 id="notice-title" className="pc-section__title">
            {n.status === 'DRAFT' ? 'Draft notice' : n.title}
          </h1>
          <p className="pc-section__lead">
            {NOTICE_KIND[n.kind].label} for {audienceText(n).toLowerCase()}.{' '}
            {n.status === 'DRAFT' ? `Drafted by ${n.createdBy.name ?? 'a former member'} on ${when(n.createdAt)}.` : `Published by ${n.publishedBy?.name ?? 'a former member'} on ${when(n.publishedAt)}.`}
          </p>
        </div>
        <span className={`pc-status ${state.tone}`}>{state.text}</span>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}

      {n.status === 'DRAFT' && canWrite ? (
        <NoticeEditor key={n.version} notice={n} onSaved={(saved) => setN(saved)} />
      ) : (
        <>
          <div className="pc-notice-record">
            <h2 className="pc-subhead">What it says, exactly as shown</h2>
            <BannerPreview kind={n.kind} title={n.title} body={n.body} startsAt={n.startsAt} endsAt={n.endsAt} />
            <dl className="pc-facts pc-facts--card">
              <div>
                <dt>Shown until</dt>
                <dd>{n.status === 'WITHDRAWN' ? `Withdrawn ${when(n.withdrawnAt)} by ${n.withdrawnBy?.name ?? 'a former member'}` : when(n.shownUntil)}</dd>
              </div>
              <div>
                <dt>Who sees it there</dt>
                <dd>{n.kind === 'MAINTENANCE' ? 'Everyone, on the sign-in page too' : 'IT Admins'}</dd>
              </div>
            </dl>
          </div>

          {n.deliveries.length ? (
            <div className="pc-notice-record">
              <h2 className="pc-subhead">
                Institutions it reached
                <span className="pc-count">{n.deliveries.length}</span>
              </h2>
              <p className="pc-note">Counts only: the platform never sees who was emailed. Kept up to date for two weeks; a failed email is one the mail server refused.</p>
              <table className="pc-table">
                <thead>
                  <tr>
                    <th scope="col">Institution</th>
                    <th scope="col">Banner</th>
                    <th scope="col" className="pc-table__num">IT Admins emailed</th>
                    <th scope="col" className="pc-table__num">Sent</th>
                    <th scope="col" className="pc-table__num">Failed</th>
                    <th scope="col" className="pc-table__num">Dismissed</th>
                  </tr>
                </thead>
                <tbody>
                  {n.deliveries.map((d) => (
                    <tr key={d.tenant.id}>
                      <td className="pc-table__strong">
                        <Link className="uv-link" href={`/institutions/${d.tenant.id}`}>
                          {d.tenant.name}
                        </Link>
                      </td>
                      <td data-label="Banner">{d.withdrawnAt ? 'Withdrawn' : n.live ? 'Showing' : 'Ended'}</td>
                      <td data-label="IT Admins emailed" className="pc-table__num">
                        {d.emailsQueued === null ? 'Not yet' : `${String(d.emailsQueued)} of ${String(d.itAdmins ?? 0)}`}
                      </td>
                      <td data-label="Sent" className="pc-table__num">
                        {d.emailsSent}
                      </td>
                      <td data-label="Failed" className="pc-table__num">
                        {d.emailsFailed ? <span className="pc-status pc-status--bad">{d.emailsFailed}</span> : 0}
                      </td>
                      <td data-label="Dismissed" className="pc-table__num">
                        {d.bannersDismissed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {n.status === 'PUBLISHED' && canWrite ? (
            <div className="pc-row-actions pc-row-actions--start pc-row-actions--wrap">
              <Button type="button" variant="quiet" className="pc-danger" pending={busy} disabled={busy} onClick={withdraw}>
                Withdraw this notice
              </Button>
              <p className="pc-note pc-row-actions__note">Its banner leaves every institution at once. To correct it, publish a new notice too.</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
