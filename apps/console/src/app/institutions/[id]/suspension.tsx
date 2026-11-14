'use client';

import type { PlatformSuspension, PlatformSuspensionReason } from '@univarse/contracts';
import { Button, ChevronDown, Notice } from '@univarse/ui';
import { useEffect, useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, field, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { STATUS, SUSPENSION_REASON } from '../labels';
import type { Changing, Tenant } from './institution-view';

const REASONS = Object.keys(SUSPENSION_REASON) as PlatformSuspensionReason[];
/** How often the page looks again while the worker ends the sessions (a resume waits for it). */
const SESSIONS_POLL_MS = 3_000;

/**
 * Spec 0037 Q6, Q7: stopping an institution, and bringing it back. One person, with a step-up and a reason from a
 * fixed list; it takes effect at once and ends every session there. While it's suspended, this section leads the page:
 * since when, by whom and why, whether the sessions are ended yet, and the one action, Resume. Staff who can't suspend
 * see the same facts without the actions.
 */
export function SuspensionSection({ tenant, canSuspend, changing }: { tenant: Tenant; canSuspend: boolean; changing: Changing }) {
  const open = tenant.status === 'SUSPENDED' ? (tenant.suspensions.find((s) => s.resumedAt === null) ?? null) : null;
  const past = tenant.suspensions.filter((s) => s.resumedAt !== null);
  const suspendable = tenant.status === 'ACTIVE' || tenant.status === 'ONBOARDING';

  if (tenant.status === 'SUSPENDED') return <Suspended tenant={tenant} open={open} past={past} canSuspend={canSuspend} changing={changing} />;
  if (!suspendable || (!canSuspend && past.length === 0)) return null;
  return (
    <section className="pc-section" aria-labelledby="t-access">
      <h2 id="t-access" className="pc-section__title">
        Access
      </h2>
      <p className="pc-section__lead">
        Suspending stops everyone at {tenant.shortName} from using UniVarse until it’s resumed.
      </p>
      {canSuspend ? <SuspendForm tenant={tenant} changing={changing} /> : null}
      <History past={past} />
    </section>
  );
}

function Suspended({ tenant, open, past, canSuspend, changing }: { tenant: Tenant; open: PlatformSuspension | null; past: PlatformSuspension[]; canSuspend: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ending = open !== null && open.sessionsEndedAt === null;

  // While the worker ends the sessions, look again every few seconds: Resume waits for it.
  useEffect(() => {
    if (!ending) return;
    const t = setTimeout(changing.reload, SESSIONS_POLL_MS);
    return () => clearTimeout(t);
  }, [ending, changing.reload, tenant]);

  const back = open ? (STATUS[open.previousStatus]?.label.toLowerCase() ?? open.previousStatus) : 'active';
  const resume = () => {
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/resume`);
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is back and ${back}. Everyone there signs in again.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="pc-section pc-suspended" aria-labelledby="t-access">
      <div className="pc-suspended__head">
        <span className="pc-suspended__mark" aria-hidden="true" />
        <div>
          <h2 id="t-access" className="pc-section__title">
            Suspended
          </h2>
          <p className="pc-section__lead">
            Everyone at {tenant.shortName} sees “temporarily unavailable”. Its notices still reach its IT Admins.
          </p>
        </div>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {open ? (
        <dl className="pc-facts pc-suspended__facts">
          <div>
            <dt>Why</dt>
            <dd>{SUSPENSION_REASON[open.reason]}</dd>
          </div>
          <div>
            <dt>Since</dt>
            <dd>
              {when(open.suspendedAt)}, by {open.suspendedBy.name ?? 'a former member'}
            </dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd aria-live="polite">{open.sessionsEndedAt === null ? 'Being ended now…' : `${sessionsText(open.sessionsEnded)} ended ${when(open.sessionsEndedAt)}`}</dd>
          </div>
          {open.note ? (
            <div className="pc-suspended__note">
              <dt>Note (staff only)</dt>
              <dd>{open.note}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="pc-note">Suspended before suspensions were recorded here{tenant.suspendedReason ? `: ${tenant.suspendedReason}` : ''}.</p>
      )}
      {canSuspend ? (
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="button" pending={busy} disabled={busy || ending} onClick={resume}>
            Resume {tenant.shortName}
          </Button>
          <p className="pc-note pc-suspended__after">{ending ? 'Resume waits until every session is ended, so none from before comes back.' : `It goes back to ${back}. Nobody’s old session works: everyone signs in again.`}</p>
        </div>
      ) : null}
      <History past={past} />
    </section>
  );
}

function SuspendForm({ tenant, changing }: { tenant: Tenant; changing: Changing }) {
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<PlatformSuspensionReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!reason) return;
    const note = field(new FormData(e.currentTarget), 'note');
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/suspend`, note ? { reason, note } : { reason });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is suspended. Its sessions are being ended now.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <details className="pc-disclosure" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="uv-link pc-danger">
        Suspend {tenant.shortName}
        <ChevronDown size={18} />
      </summary>
      <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={submit} noValidate>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Why?</legend>
          <div className="pc-choices">
            {REASONS.map((r) => (
              <label key={r} className="pc-check">
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} required />
                <span>{SUSPENSION_REASON[r]}</span>
              </label>
            ))}
          </div>
          <p className="pc-note">Unpaid fees aren’t a reason: they hold new admissions and registrations, never sign-in.</p>
        </fieldset>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="suspend-note">
            {reason === 'OTHER' ? 'Note' : 'Note (optional)'}
          </label>
          <textarea id="suspend-note" name="note" className="uv-field__input pc-textarea" rows={2} minLength={3} maxLength={200} required={reason === 'OTHER'} />
          <p className="pc-note">Staff only, never shown at the institution. Up to 200 characters, and no one’s personal details.</p>
        </div>
        <Notice tone="info">
          At once, everyone at {tenant.shortName} is signed out and sees “temporarily unavailable” on its address. Resuming brings it back as it was; everyone signs in again.
        </Notice>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" variant="quiet" className="pc-danger" pending={busy} disabled={!reason || busy}>
            Suspend {tenant.shortName}
          </Button>
        </div>
      </form>
    </details>
  );
}

function History({ past }: { past: PlatformSuspension[] }) {
  if (past.length === 0) return null;
  return (
    <div className="pc-suspended__history">
      <h3 className="pc-subhead">Earlier suspensions</h3>
      <ul className="pc-suspended__past">
        {past.map((s) => (
          <li key={s.id} className="pc-note">
            {SUSPENSION_REASON[s.reason]}: {when(s.suspendedAt)} by {s.suspendedBy.name ?? 'a former member'}, resumed {when(s.resumedAt)} by {s.resumedBy?.name ?? 'a former member'}.
          </li>
        ))}
      </ul>
    </div>
  );
}

const sessionsText = (n: number | null) => (n === 1 ? '1 session' : `${String(n ?? 0)} sessions`);
