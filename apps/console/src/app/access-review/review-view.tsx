'use client';

import type { PlatformAccessReview as Review } from '@univarse/contracts';
import { Button, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_LABEL, useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { useStepUp } from '../../components/step-up';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';

type Member = Review['members'][number];
type Decision = 'keep' | 'change';

const MONTH = new Intl.DateTimeFormat('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthOf = (period: string) => MONTH.format(new Date(`${period}-01T00:00:00Z`));

const STATUS: Record<Review['status'], { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'pc-status--on' },
  due: { label: 'Due this month', tone: 'pc-status--wait' },
  overdue: { label: 'Overdue', tone: 'pc-status--bad' },
};

/**
 * The monthly access review (spec 0031 Q15): is everyone who can reach the console still meant to? The reviewer marks
 * each member and attests, and that record is fixed. A review changes nothing itself: "needs a change" is a note to act
 * on in Staff. Attesting asks for the authenticator. If anyone's access changed since the page loaded, the server
 * refuses, and the page reloads what's true now.
 */
export function ReviewView() {
  const me = useMe();
  const stepUp = useStepUp();
  const canRead = me.permissions.includes('platform.access_review.read');
  const canAttest = me.permissions.includes('platform.access_review.attest');
  const [review, setReview] = useState<Review | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!canRead) return;
    api<Review>('GET', '/access-review')
      .then(setReview)
      .catch((err: unknown) => setError(asApiError(err)));
  }, [canRead]);
  useEffect(load, [load]);

  const remaining = useMemo(() => (review ? review.members.filter((m) => !decisions[m.id]).length : 0), [review, decisions]);

  const attest = () => {
    if (!review || remaining > 0) return;
    setBusy(true);
    setError(null);
    const body = {
      snapshotHash: review.snapshotHash,
      decisions: review.members.map((m) => {
        const decision = decisions[m.id] ?? 'change'; // never reached: every member is marked. Never a quiet keep.
        const note = decision === 'change' ? notes[m.id]?.trim() : undefined; // a note left behind on a switch back to Keep
        return { memberId: m.id, decision, ...(note ? { note } : {}) };
      }),
    };
    stepUp(() => api('POST', '/access-review', body))
      .then((r) => {
        if (r === undefined) return;
        setDone(true);
        load();
      })
      .catch((err: unknown) => {
        setError(asApiError(err));
        load();
      })
      .finally(() => setBusy(false));
  };

  if (!canRead) return <NothingHere />;

  const status = review ? STATUS[review.status] : null;

  return (
    <>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {done ? <Notice tone="success">This month’s review is attested and recorded.</Notice> : null}

      <section className="pc-section" aria-labelledby="review-title">
        <div className="pc-section__head">
          <div>
            <h1 id="review-title" className="pc-section__title">
              Access review{review ? `: ${monthOf(review.period)}` : ''}
            </h1>
            <p className="pc-section__lead">Once a month, confirm that everyone who can reach the console is still meant to.</p>
          </div>
          {status ? <span className={`pc-status ${status.tone}`}>{status.label}</span> : null}
        </div>

        {review === null && !error ? <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" /> : null}

        {review && review.status === 'done' ? <p className="pc-empty">This month’s review is done. The next one is due next month.</p> : null}

        {review && review.status !== 'done' ? (
          <>
            {review.members.length === 1 ? (
              <p className="pc-note">You’re the only staff member, so you’re reviewing your own access. It’s recorded as that, not as an independent review.</p>
            ) : null}
            <ul className="pc-review">
              {review.members.map((m) => (
                <ReviewRow
                  key={m.id}
                  member={m}
                  you={m.id === me.id}
                  canDecide={canAttest}
                  decision={decisions[m.id]}
                  note={notes[m.id] ?? ''}
                  onDecide={(d) => setDecisions((held) => ({ ...held, [m.id]: d }))}
                  onNote={(text) => setNotes((held) => ({ ...held, [m.id]: text }))}
                />
              ))}
            </ul>
            {canAttest ? (
              <div className="pc-review__end">
                <p className="pc-note">{remaining > 0 ? `${String(remaining)} still to mark.` : 'Attesting records this list as you see it. It can’t be edited afterwards, and it changes nobody’s access: make any change in Staff.'}</p>
                <Button type="button" pending={busy} disabled={remaining > 0} onClick={attest}>
                  Attest this review
                </Button>
              </div>
            ) : (
              <p className="pc-note">Only an owner can attest the review.</p>
            )}
          </>
        ) : null}
      </section>

      {review && review.history.length > 0 ? (
        <section className="pc-section" aria-labelledby="review-history">
          <h2 id="review-history" className="pc-subhead">
            Past reviews
          </h2>
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Attested by</th>
                <th scope="col">When</th>
                <th scope="col">Members</th>
                <th scope="col">Needing a change</th>
              </tr>
            </thead>
            <tbody>
              {review.history.map((h) => (
                <tr key={h.id}>
                  <td className="pc-table__strong">{monthOf(h.period)}</td>
                  <td data-label="Attested by">{h.reviewer.name ?? 'A former staff member'}</td>
                  <td data-label="When">{when(h.attestedAt)}</td>
                  <td data-label="Members">{h.members}</td>
                  <td data-label="Needing a change">{h.changesNeeded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

function ReviewRow({
  member,
  you,
  canDecide,
  decision,
  note,
  onDecide,
  onNote,
}: {
  member: Member;
  you: boolean;
  canDecide: boolean;
  decision: Decision | undefined;
  note: string;
  onDecide: (d: Decision) => void;
  onNote: (text: string) => void;
}) {
  const group = `review-${member.id}`;
  return (
    <li className="pc-review__row" data-inactive={member.isActive ? undefined : 'true'}>
      <div className="pc-review__who">
        <p className="pc-member__name">
          {member.displayName}
          {you ? <span className="pc-member__you"> (you)</span> : null}
        </p>
        <p className="pc-review__facts">
          <span className="pc-role">{ROLE_LABEL[member.role] ?? member.role}</span>
          {!member.isActive ? (
            <span className="pc-status pc-status--off">No access</span>
          ) : member.mfaEnrolled ? (
            <span className="pc-status pc-status--on">Authenticator on</span>
          ) : (
            <span className="pc-status pc-status--wait">Not activated yet</span>
          )}
          <span className="pc-member__seen">Last signed in: {when(member.lastLoginAt)}</span>
        </p>
      </div>
      {canDecide ? (
        <fieldset className="pc-seg pc-seg--choice">
          <legend className="uv-visually-hidden">Decision for {member.displayName}</legend>
          {(['keep', 'change'] as const).map((d) => (
            <label key={d} className="pc-seg__opt" data-on={decision === d ? 'true' : undefined}>
              <input type="radio" name={group} value={d} checked={decision === d} onChange={() => onDecide(d)} />
              {d === 'keep' ? 'Keep' : 'Needs a change'}
            </label>
          ))}
        </fieldset>
      ) : null}
      {decision === 'change' ? (
        <div className="pc-review__note uv-field">
          <label className="uv-field__label" htmlFor={`${group}-note`}>
            What needs to change? (optional)
          </label>
          <textarea id={`${group}-note`} className="uv-field__input" rows={2} maxLength={500} value={note} onChange={(e) => onNote(e.target.value)} />
          <p className="pc-note">
            Stored with this review. Make the change itself in <Link href="/staff">Staff</Link>.
          </p>
        </div>
      ) : null}
    </li>
  );
}
