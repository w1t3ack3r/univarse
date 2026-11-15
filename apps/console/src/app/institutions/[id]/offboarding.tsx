'use client';

import type { PlatformOffboarding, PlatformOffboardingReason, PlatformTenantExportView } from '@univarse/contracts';
import { Button, ChevronDown, Notice } from '@univarse/ui';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, field, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { OFFBOARDING_REASON } from '../labels';
import type { Changing, Tenant } from './institution-view';
import { PurgeSection } from './purge';

const REASONS = Object.keys(OFFBOARDING_REASON) as PlatformOffboardingReason[];
const day = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });

/**
 * Spec 0038 Q2–Q6, Q15: an institution's departure. While it's leaving, this section leads the page: the days left and
 * the day it closes, why and who started it, the warnings its IT Admins were sent (counts only), and Cancel. Once
 * archived: when, the sessions ended, and one 14-day extension. Otherwise, for those who may, starting it sits with the
 * other changes. Everyone else reads the same facts without the actions.
 */
export function OffboardingSection({ tenant, canOffboard, changing }: { tenant: Tenant; canOffboard: boolean; changing: Changing }) {
  const o = tenant.offboarding;
  const open = o && !o.cancelledAt ? o : null;
  // Spec 0038 Q13, Q15: a purged institution's page leads with what was deleted, and its certificate.
  if (tenant.status === 'PURGED') return <PurgeSection tenant={tenant} canOffboard={canOffboard} changing={changing} />;
  if (open && (tenant.status === 'OFFBOARDING' || tenant.status === 'SUSPENDED')) return <Leaving tenant={tenant} o={open} canOffboard={canOffboard} changing={changing} />;
  if (open && tenant.status === 'ARCHIVED') return <Archived tenant={tenant} o={open} canOffboard={canOffboard} changing={changing} />;
  if (!canOffboard || (tenant.status !== 'ACTIVE' && tenant.status !== 'ONBOARDING')) return null;
  return (
    <section className="pc-section" aria-labelledby="t-offboarding">
      <h2 id="t-offboarding" className="pc-section__title">
        Leaving UniVarse
      </h2>
      <p className="pc-section__lead">Offboarding gives {tenant.shortName} 60 days to take its data, then closes its account. Its data is deleted only when two people approve it.</p>
      <StartForm tenant={tenant} changing={changing} />
    </section>
  );
}

function Warnings({ o }: { o: PlatformOffboarding }) {
  if (o.warnings.length === 0) return <p className="pc-note">No warning sent yet. The first goes out within minutes of starting.</p>;
  return (
    <table className="pc-table">
      <thead>
        <tr>
          <th scope="col">Warning</th>
          <th scope="col" className="pc-table__num">
            IT Admins emailed
          </th>
          <th scope="col">Sent</th>
        </tr>
      </thead>
      <tbody>
        {o.warnings.map((w) => (
          <tr key={`${String(w.round)}-${String(w.daysLeft)}`}>
            <td className="pc-table__strong">{w.round === 1 && w.daysLeft === 14 ? 'The extension' : w.daysLeft === 60 ? 'The start' : `${String(w.daysLeft)} ${w.daysLeft === 1 ? 'day' : 'days'} left`}</td>
            <td data-label="IT Admins emailed" className="pc-table__num">
              {w.emailsQueued === null ? 'Sending' : `${String(w.emailsQueued)} of ${String(w.itAdmins ?? 0)}`}
            </td>
            <td data-label="Sent">{w.queuedAt ? when(w.queuedAt) : 'Not yet'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EXPORT_STATE: Record<PlatformTenantExportView['state'], string> = {
  REQUESTED: 'Being prepared',
  BUILDING: 'Being prepared',
  READY: 'Ready to download',
  FAILED: 'Didn’t finish',
  EXPIRED: 'Deleted after 7 days',
};
const count = new Intl.NumberFormat('en-NG');
const megabytes = (b: number) => (b < 1_000_000 ? `${count.format(Math.max(1, Math.round(b / 1000)))} kB` : `${(b / 1_000_000).toFixed(1)} MB`);

/**
 * Spec 0038 Q8, Q15: whether the institution has taken its export, as the worker mirrors it: the state, when, its size and
 * its counts. Never its content, its passphrase or a way to download it: that's the institution's, in its workspace.
 */
function ExportRecord({ tenant }: { tenant: Tenant }) {
  const latest = tenant.exports[0];
  return (
    <div className="pc-notice-record">
      <h3 className="pc-subhead">Its data export</h3>
      {latest ? (
        <dl className="pc-facts">
          <div>
            <dt>Latest</dt>
            <dd>
              {EXPORT_STATE[latest.state]}, asked for {when(latest.requestedAt)}
            </dd>
          </div>
          {latest.state === 'READY' || latest.state === 'EXPIRED' ? (
            <div>
              <dt>Contents</dt>
              <dd>
                {megabytes(latest.sizeBytes ?? 0)}: {count.format(latest.rows ?? 0)} records in {String(latest.tables ?? 0)} tables, {count.format(latest.files ?? 0)} documents
              </dd>
            </div>
          ) : null}
          {latest.state === 'READY' && latest.expiresAt ? (
            <div>
              <dt>Available</dt>
              <dd>Until {when(latest.expiresAt)}</dd>
            </div>
          ) : null}
          {tenant.exports.length > 1 ? (
            <div>
              <dt>Earlier</dt>
              <dd>{`${String(tenant.exports.length - 1)} more, the last ${when(tenant.exports[tenant.exports.length - 1]?.requestedAt ?? latest.requestedAt)}`}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="pc-note">Its IT Admins haven’t asked for an export yet. They do it in their own workspace; UniVarse staff can’t take one for them.</p>
      )}
    </div>
  );
}

function Leaving({ tenant, o, canOffboard, changing }: { tenant: Tenant; o: PlatformOffboarding; canOffboard: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const cancel = () => {
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/offboarding/cancel`);
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is staying. Its offboarding is cancelled and nothing was lost.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="pc-section pc-leaving" aria-labelledby="t-offboarding">
      <div className="pc-leaving__head">
        <p className="pc-leaving__count" aria-hidden="true">
          <span className="pc-leaving__days">{o.daysLeft}</span>
          <span className="pc-leaving__unit">{o.daysLeft === 1 ? 'day' : 'days'}</span>
        </p>
        <div>
          <h2 id="t-offboarding" className="pc-section__title">
            Leaving: {o.daysLeft === 1 ? 'the last day' : `${String(o.daysLeft)} days left`}
          </h2>
          <p className="pc-section__lead">
            {tenant.shortName} closes at the end of {day.format(new Date(o.endsAt))}. Until then it works as usual, with a banner saying so.
            {tenant.status === 'SUSPENDED' ? ' It’s suspended now; the clock keeps running.' : ''}
          </p>
        </div>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <dl className="pc-facts pc-facts--card">
        <div>
          <dt>Why</dt>
          <dd>{OFFBOARDING_REASON[o.reason]}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            {when(o.startedAt)}, by {o.startedBy.name ?? 'a former member'}
          </dd>
        </div>
        {o.extendedAt ? (
          <div>
            <dt>Extended</dt>
            <dd>
              {when(o.extendedAt)}, by {o.extendedBy?.name ?? 'a former member'}: {o.extensionReason}
            </dd>
          </div>
        ) : null}
        {o.note ? (
          <div className="pc-suspended__note">
            <dt>Note (staff only)</dt>
            <dd>{o.note}</dd>
          </div>
        ) : null}
      </dl>
      <div className="pc-notice-record">
        <h3 className="pc-subhead">Warnings to its IT Admins</h3>
        <Warnings o={o} />
      </div>
      <ExportRecord tenant={tenant} />
      {canOffboard && tenant.status === 'OFFBOARDING' ? (
        <div className="pc-row-actions pc-row-actions--start pc-row-actions--wrap">
          <Button type="button" variant="quiet" pending={busy} onClick={cancel}>
            Cancel the offboarding
          </Button>
          <p className="pc-note pc-row-actions__note">{tenant.shortName} goes back to {o.previousStatus === 'ACTIVE' ? 'live' : 'onboarding'}. Nothing has been deleted.</p>
        </div>
      ) : null}
    </section>
  );
}

function Archived({ tenant, o, canOffboard, changing }: { tenant: Tenant; o: PlatformOffboarding; canOffboard: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const extend = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = field(new FormData(e.currentTarget), 'reason');
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/offboarding/extend`, { reason });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is open again for 14 days. Its IT Admins are being told.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="pc-section pc-suspended" aria-labelledby="t-offboarding">
      <div className="pc-suspended__head">
        <span className="pc-suspended__mark" aria-hidden="true" />
        <div>
          <h2 id="t-offboarding" className="pc-section__title">
            Closed
          </h2>
          <p className="pc-section__lead">
            {tenant.shortName}’s account closed {when(o.archivedAt)}. Its address says so, and nobody can sign in. Its data is still here until two people approve its deletion.
          </p>
        </div>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <dl className="pc-facts pc-suspended__facts">
        <div>
          <dt>Sessions</dt>
          <dd>{o.sessionsEndedAt ? `Ended ${when(o.sessionsEndedAt)}` : 'Being ended now…'}</dd>
        </div>
        <div>
          <dt>Why it left</dt>
          <dd>{OFFBOARDING_REASON[o.reason]}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>
            {when(o.startedAt)} to {day.format(new Date(o.endsAt))}
            {o.extendedAt ? ', extended once' : ''}
          </dd>
        </div>
      </dl>
      <ExportRecord tenant={tenant} />
      <PurgeSection tenant={tenant} canOffboard={canOffboard} changing={changing} />
      {canOffboard && !o.extendedAt && !tenant.purge?.run ? (
        <details className="pc-disclosure">
          <summary className="uv-link">
            Give it 14 more days
            <ChevronDown size={18} />
          </summary>
          <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={extend} noValidate>
            <div className="uv-field">
              <label className="uv-field__label" htmlFor="extend-reason">
                Why?
              </label>
              <textarea id="extend-reason" name="reason" className="uv-field__input pc-textarea" rows={2} minLength={3} maxLength={200} required />
              <p className="pc-note">Once only. The account opens again, everyone signs in again, and its IT Admins are told the new date.</p>
            </div>
            <div className="pc-row-actions pc-row-actions--start">
              <Button type="submit" variant="quiet" pending={busy}>
                Give {tenant.shortName} 14 more days
              </Button>
            </div>
          </form>
        </details>
      ) : null}
      {o.extendedAt ? <p className="pc-note">It was given 14 more days once, {when(o.extendedAt)}. It can’t be extended again.</p> : null}
    </section>
  );
}

function StartForm({ tenant, changing }: { tenant: Tenant; changing: Changing }) {
  const stepUp = useStepUp();
  const [reason, setReason] = useState<PlatformOffboardingReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const closes = new Date(Date.now() + 60 * 86_400_000);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!reason) return;
    const note = field(new FormData(e.currentTarget), 'note');
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/offboarding`, note ? { reason, note } : { reason });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is leaving. Its IT Admins are being told, and it closes in 60 days.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <details className="pc-disclosure">
      <summary className="uv-link pc-danger">
        Start offboarding {tenant.shortName}
        <ChevronDown size={18} />
      </summary>
      <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={submit} noValidate>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Why is it leaving?</legend>
          <div className="pc-choices">
            {REASONS.map((r) => (
              <label key={r} className="pc-check">
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} required />
                <span>{OFFBOARDING_REASON[r]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="offboard-note">
            {reason === 'OTHER' ? 'Note' : 'Note (optional)'}
          </label>
          <textarea id="offboard-note" name="note" className="uv-field__input pc-textarea" rows={2} minLength={3} maxLength={200} required={reason === 'OTHER'} />
          <p className="pc-note">Staff only. Up to 200 characters, and no one’s personal details.</p>
        </div>
        <Notice tone="info">
          {tenant.shortName} keeps working until the end of about {day.format(closes)}, with a banner saying so. Its IT Admins are warned at 60, 45, 30, 14, 7 and 1 days. Then its account closes. You can cancel any time before that.
        </Notice>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" variant="quiet" className="pc-danger" pending={busy} disabled={!reason || busy}>
            Start offboarding {tenant.shortName}
          </Button>
        </div>
      </form>
    </details>
  );
}
