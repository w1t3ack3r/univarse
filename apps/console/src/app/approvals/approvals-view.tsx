'use client';

import type { PlatformApproval } from '@univarse/contracts';
import { ArrowRight, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { APPROVAL_STATUS, approvalAction, timeLeft } from '../../lib/approvals';
import { api, ApiError, asApiError } from '../../lib/api';
import { when } from '../../lib/device';

/**
 * Spec 0037 Q2 (E4): the two-person requests this member may see: those waiting for them first, then their own, then
 * the rest of what was decided. Everyone can open it; a member who can neither ask nor decide sees an empty page.
 */
export function ApprovalsView() {
  const me = useMe();
  const [rows, setRows] = useState<PlatformApproval[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ data: PlatformApproval[] }>('GET', '/approvals')
      .then((r) => setRows(r.data))
      .catch((err: unknown) => setError(asApiError(err)));
  }, []);

  const forYou = rows?.filter((a) => a.canDecide) ?? [];
  const yours = rows?.filter((a) => a.requestedBy.id === me.id) ?? [];
  const others = rows?.filter((a) => !a.canDecide && a.requestedBy.id !== me.id) ?? [];

  return (
    <section className="pc-section" aria-labelledby="approvals-title">
      <h1 id="approvals-title" className="pc-section__title">
        Approvals
      </h1>
      <p className="pc-section__lead">Changes that need two people. One member asks; another approves exactly what was asked, and it runs at once.</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {rows === null ? (
        error ? null : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
      ) : rows.length === 0 ? (
        <p className="pc-empty">
          No requests yet. Making someone an owner starts one, from <Link href="/staff">Staff</Link>.
        </p>
      ) : (
        <>
          <Group title="Waiting for you" rows={forYou} empty="Nothing waits for your decision." meId={me.id} />
          <Group title="Your requests" rows={yours} empty="You haven’t asked for anything." meId={me.id} />
          {others.length ? <Group title="Other requests" rows={others} empty="" meId={me.id} /> : null}
        </>
      )}
    </section>
  );
}

function Group({ title, rows, empty, meId }: { title: string; rows: readonly PlatformApproval[]; empty: string; meId: string }) {
  const id = `group-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="pc-approvals__group" aria-labelledby={id} role="group">
      <h2 id={id} className="pc-subhead">
        {title}
        {rows.length ? <span className="pc-count">{rows.length}</span> : null}
      </h2>
      {rows.length === 0 ? (
        <p className="pc-note">{empty}</p>
      ) : (
        <ul className="pc-list">
          {rows.map((a) => {
            const status = APPROVAL_STATUS[a.status];
            return (
              <li key={a.id}>
                <Link className="pc-list__row" href={`/approvals/${a.id}`}>
                  <span className="pc-list__text">
                    <span className="pc-list__title">{approvalAction(a)}</span>
                    <span className="pc-list__meta">
                      {a.requestedBy.id === meId ? 'You asked' : `${a.requestedBy.name ?? 'A former member'} asked`} on {when(a.requestedAt)}
                      {a.status === 'PENDING' ? `, expires ${timeLeft(a.expiresAt)}` : ''}
                    </span>
                  </span>
                  <span className={`pc-status ${status.tone}`}>{status.text}</span>
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
