'use client';

import type { PlatformApproval } from '@univarse/contracts';
import { ArrowLeft, Button, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { useStepUp } from '../../../components/step-up';
import { APPROVAL_CONSEQUENCE, APPROVAL_FAILURE, APPROVAL_STATUS, approvalAction, timeLeft } from '../../../lib/approvals';
import { api, ApiError, asApiError } from '../../../lib/api';
import { when } from '../../../lib/device';

/**
 * Spec 0037 Q3 (T24): one two-person request. It shows exactly what will run, the payload and its hash, before anyone
 * decides; approving sends that hash back, so a request changed under the page is refused. A decision asks for a
 * step-up. Someone who may not see it gets the page an unknown address gets.
 */
export function ApprovalView() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const stepUp = useStepUp();
  const [a, setA] = useState<PlatformApproval | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'cancel' | null>(null);

  const load = useCallback(() => {
    api<PlatformApproval>('GET', `/approvals/${id}`)
      .then(setA)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(asApiError(err));
      });
  }, [id]);
  useEffect(load, [load]);

  const act = async (what: 'approve' | 'reject' | 'cancel') => {
    if (!a) return;
    setBusy(what);
    setError(null);
    try {
      const body = what === 'approve' ? { payloadHash: a.payloadHash } : undefined;
      const r = what === 'cancel' ? await api<PlatformApproval>('POST', `/approvals/${a.id}/cancel`) : await stepUp(() => api<PlatformApproval>('POST', `/approvals/${a.id}/${what}`, body));
      if (r) setA(r);
    } catch (err) {
      setError(asApiError(err));
      load(); // whatever changed underneath, show it as it is now
    } finally {
      setBusy(null);
    }
  };

  if (missing) return <NothingHere />;
  if (!a) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />;

  const status = APPROVAL_STATUS[a.status];
  const action = approvalAction(a);
  const mine = a.requestedBy.id === me.id;

  return (
    <section className="pc-section pc-approval" aria-labelledby="approval-title">
      <Link className="uv-link pc-back" href="/approvals">
        <ArrowLeft size={18} />
        Approvals
      </Link>
      <div className="pc-section__head">
        <div>
          <h1 id="approval-title" className="pc-section__title">
            {action}
          </h1>
          <p className="pc-section__lead">
            Asked by {mine ? 'you' : (a.requestedBy.name ?? 'a former member')} on {when(a.requestedAt)}.
            {a.status === 'PENDING' ? ` It expires ${timeLeft(a.expiresAt)}.` : null}
          </p>
        </div>
        <span className={`pc-status ${status.tone}`}>{status.text}</span>
      </div>

      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

      <figure className="pc-approval__ask">
        <figcaption className="pc-approval__label">Why they asked</figcaption>
        <blockquote className="pc-approval__reason">{a.reason}</blockquote>
      </figure>

      <div className="pc-approval__run" aria-labelledby="run-title">
        <h2 id="run-title" className="pc-subhead">
          Exactly what will run
        </h2>
        <p className="pc-note">{APPROVAL_CONSEQUENCE[a.kind]}</p>
        <dl className="pc-approval__receipt">
          <div className="pc-approval__pair">
            <dt>Action</dt>
            <dd className="pc-table__mono">{a.kind}</dd>
          </div>
          {Object.entries(a.payload).map(([k, v]) => (
            <div key={k} className="pc-approval__pair">
              <dt>{k}</dt>
              <dd className="pc-table__mono">
                {String(v)}
                {a.subject && v === a.subject.id && a.subject.name ? <span className="pc-approval__who">{a.subject.name}</span> : null}
              </dd>
            </div>
          ))}
          <div className="pc-approval__pair">
            <dt>Fingerprint</dt>
            <dd className="pc-table__mono pc-approval__hash">{a.payloadHash}</dd>
          </div>
        </dl>
        <p className="pc-note">Approving sends this fingerprint back. If the request changed after this page loaded, it’s refused.</p>
      </div>

      <Decision a={a} mine={mine} aboutMe={a.subject?.id === me.id} busy={busy} onAct={(w) => void act(w)} />
    </section>
  );
}

function Decision({ a, mine, aboutMe, busy, onAct }: { a: PlatformApproval; mine: boolean; aboutMe: boolean; busy: string | null; onAct: (w: 'approve' | 'reject' | 'cancel') => void }) {
  if (a.status === 'EXECUTED')
    return (
      <Notice tone="success">
        Approved by {a.decidedBy?.name ?? 'a former member'} on {when(a.decidedAt)}, and done.
      </Notice>
    );
  if (a.status === 'FAILED')
    return (
      <Notice>
        Approved by {a.decidedBy?.name ?? 'a former member'} on {when(a.decidedAt)}, but not done. {a.failureCode ? APPROVAL_FAILURE[a.failureCode] : null} Nothing changed; ask again if it’s still needed.
      </Notice>
    );
  if (a.status === 'REJECTED')
    return (
      <p className="pc-approval__closed">
        Rejected by {a.decidedBy?.name ?? 'a former member'} on {when(a.decidedAt)}. Nothing changed.
      </p>
    );
  if (a.status === 'CANCELLED') return <p className="pc-approval__closed">Cancelled by the person who asked. Nothing changed.</p>;
  if (a.status === 'EXPIRED') return <p className="pc-approval__closed">Nobody decided it in time. Nothing changed; ask again if it’s still needed.</p>;

  if (a.canDecide)
    return (
      <div className="pc-approval__decide">
        <p className="pc-approval__you">You’re the second person. Approving runs it at once, and both your names go in the audit log.</p>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="button" pending={busy === 'approve'} disabled={busy !== null} onClick={() => onAct('approve')}>
            Approve: {approvalAction(a).replace(/^Make/, 'make')}
          </Button>
          <Button type="button" variant="quiet" className="pc-danger" pending={busy === 'reject'} disabled={busy !== null} onClick={() => onAct('reject')}>
            Reject
          </Button>
        </div>
      </div>
    );
  return (
    <div className="pc-approval__decide">
      <p className="pc-approval__you">
        {mine
          ? 'Another owner or super admin has to decide this. They were emailed, and it waits in their inbox.'
          : aboutMe
            ? 'This request is about you, so someone else decides it.'
            : 'You can’t decide this request.'}
      </p>
      {a.canCancel ? (
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="button" variant="quiet" pending={busy === 'cancel'} disabled={busy !== null} onClick={() => onAct('cancel')}>
            Cancel the request
          </Button>
        </div>
      ) : null}
    </div>
  );
}
