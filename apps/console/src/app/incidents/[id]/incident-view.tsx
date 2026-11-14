'use client';

import type { PlatformIncident } from '@univarse/contracts';
import { ArrowLeft, Button, Clock, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { useStepUp } from '../../../components/step-up';
import { api, ApiError, asApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { clockText, INCIDENT_PROBLEM, INCIDENT_STATUS, PERSONAL_DATA, SEVERITY } from '../../../lib/incidents';

type Status = PlatformIncident['status'];

/**
 * Spec 0037 Q13, Q14: one incident. Its state, the 72-hour clock when personal data may be involved, the institutions
 * it affects, then its timeline, newest first: what institutions were told, and below each, set apart, the staff-only
 * note. Those who run incidents post an update (it's never edited) and, once resolved, write the follow-up.
 */
export function IncidentView() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const [i, setI] = useState<PlatformIncident | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const canRead = me.permissions.includes('platform.tenant.read');
  const canRun = me.permissions.includes('platform.incident.manage');

  const load = useCallback(() => {
    api<PlatformIncident>('GET', `/incidents/${id}`)
      .then(setI)
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setMissing(true);
        else setError(asApiError(err));
      });
  }, [id]);
  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  if (!canRead || missing) return <NothingHere />;
  if (!i) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />;

  const open = i.status !== 'RESOLVED';
  const clock = i.breachDeadline ? clockText(i.breachDeadline) : null;

  return (
    <section className="pc-section pc-incident" aria-labelledby="incident-title">
      <Link className="uv-link pc-back" href="/incidents">
        <ArrowLeft size={18} />
        Incidents
      </Link>
      <div className="pc-section__head">
        <div>
          <h1 id="incident-title" className="pc-section__title">
            {i.title}
          </h1>
          <p className="pc-section__lead">
            Started {when(i.startedAt)}; we knew {when(i.awareAt)}. Opened by {i.openedBy.name ?? 'a former member'}.
            {i.resolvedAt ? ` Resolved ${when(i.resolvedAt)}.` : ''}
          </p>
        </div>
        <span className="pc-incident__chips">
          <span className={`pc-status ${SEVERITY[i.severity].tone}`}>{SEVERITY[i.severity].label}</span>
          <span className={`pc-status ${INCIDENT_STATUS[i.status].tone}`}>{INCIDENT_STATUS[i.status].label}</span>
        </span>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

      {clock ? (
        <div className={`pc-incident__clock${clock.overdue && open ? ' pc-incident__clock--overdue' : ''}`} role="status">
          <span className="pc-incident__clock-mark" aria-hidden="true">
            <Clock size={20} />
          </span>
          <div>
            <p className="pc-incident__clock-head">
              Personal data: {PERSONAL_DATA[i.personalData].toLowerCase()}. {open ? clock.text : 'Clock stopped: resolved.'}
            </p>
            <p className="pc-note">
              The 72 hours to report a breach run from when we knew, to {when(i.breachDeadline)}. The institutions are the controllers: make sure they’ve been told. Nothing is sent by the system.
            </p>
          </div>
        </div>
      ) : null}

      <dl className="pc-facts pc-facts--card">
        <div>
          <dt>Affects</dt>
          <dd>{i.scope === 'ALL' ? `Every institution (${String(i.institutions)})` : i.tenants.map((t) => t.name).join(', ')}</dd>
        </div>
        <div>
          <dt>What they see now</dt>
          <dd>{open ? 'A banner with the latest public update' : 'The resolved banner, for a day after resolving'}</dd>
        </div>
      </dl>

      {open && canRun ? <PostUpdate incident={i} onPosted={setI} /> : null}

      <div className="pc-incident__timeline-wrap">
        <h2 className="pc-subhead">Timeline</h2>
        <ol className="pc-timeline">
          {i.updates.map((u) => (
            <li key={u.id} className="pc-timeline__item">
              <div className="pc-timeline__meta">
                <span className={`pc-status ${INCIDENT_STATUS[u.status].tone}`}>{INCIDENT_STATUS[u.status].label}</span>
                <span className="pc-note">
                  {when(u.createdAt)} · {u.postedBy.name ?? 'a former member'} · {SEVERITY[u.severity].label}
                </span>
              </div>
              <p className="pc-timeline__public">{u.publicText}</p>
              {u.internalNote ? (
                <div className="pc-timeline__note">
                  <p className="pc-timeline__note-label">Internal note, staff only</p>
                  <p className="pc-timeline__note-text">{u.internalNote}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      {!open ? <Followup incident={i} canWrite={canRun} onSaved={setI} /> : null}
    </section>
  );
}

function PostUpdate({ incident, onPosted }: { incident: PlatformIncident; onPosted: (i: PlatformIncident) => void }) {
  const stepUp = useStepUp();
  const [status, setStatus] = useState<Status>(incident.status);
  const [severity, setSeverity] = useState(incident.severity);
  const [personal, setPersonal] = useState(incident.personalData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const problem = (path: string) => error?.fieldErrors.filter((e) => e.path === path).map((e) => INCIDENT_PROBLEM[e.code] ?? e.code)[0];

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => {
      const v = data.get(name);
      return typeof v === 'string' ? v : '';
    };
    setBusy(true);
    setError(null);
    stepUp(() =>
      api<PlatformIncident>(
        'POST',
        `/incidents/${incident.id}/updates`,
        { status, severity, personalData: personal, publicText: text('publicText'), internalNote: text('internalNote').trim() || null },
        { ifMatch: `"v${String(incident.version)}"` },
      ),
    )
      .then((r) => {
        if (!r) return;
        form.reset();
        onPosted(r);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form method="post" className="pc-form pc-incident-form pc-incident__post" onSubmit={submit} noValidate aria-labelledby="post-title">
      <h2 id="post-title" className="pc-subhead">
        Post an update
      </h2>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <fieldset className="pc-fieldset">
        <legend className="uv-field__label">Status</legend>
        <div className="pc-seg pc-seg--choice">
          {(Object.keys(INCIDENT_STATUS) as Status[]).map((s) => (
            <label key={s} className="pc-seg__opt" data-on={status === s ? 'true' : undefined}>
              <input type="radio" name="status" value={s} checked={status === s} onChange={() => setStatus(s)} />
              {INCIDENT_STATUS[s].label}
            </label>
          ))}
        </div>
        <p className="pc-note">{INCIDENT_STATUS[status].about}</p>
      </fieldset>
      <div className="pc-incident__pair">
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Severity</legend>
          <div className="pc-seg pc-seg--choice">
            {(Object.keys(SEVERITY) as (keyof typeof SEVERITY)[]).map((s) => (
              <label key={s} className="pc-seg__opt" data-on={severity === s ? 'true' : undefined}>
                <input type="radio" name="severity" value={s} checked={severity === s} onChange={() => setSeverity(s)} />
                {SEVERITY[s].label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Personal data involved?</legend>
          <div className="pc-seg pc-seg--choice">
            {(['UNKNOWN', 'YES', 'NO'] as const).map((p) => (
              <label key={p} className="pc-seg__opt" data-on={personal === p ? 'true' : undefined}>
                <input type="radio" name="personalData" value={p} checked={personal === p} onChange={() => setPersonal(p)} />
                {PERSONAL_DATA[p]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="uv-field">
        <label className="uv-field__label" htmlFor="update-public">
          What institutions are told
        </label>
        <textarea id="update-public" name="publicText" className="uv-field__input pc-textarea" rows={3} maxLength={1000} required aria-describedby="update-public-hint" />
        <p id="update-public-hint" className={problem('publicText') ? 'uv-field__error' : 'pc-note'}>
          {problem('publicText') ?? 'Replaces what their banner says now. Plain text.'}
        </p>
      </div>
      <div className="uv-field">
        <label className="uv-field__label" htmlFor="update-note">
          Internal note (optional)
        </label>
        <textarea id="update-note" name="internalNote" className="uv-field__input pc-textarea" rows={2} maxLength={2000} />
        <p className="pc-note">Staff only.</p>
      </div>
      <div className="pc-row-actions pc-row-actions--start pc-row-actions--wrap">
        <Button type="submit" pending={busy}>
          {status === 'RESOLVED' ? 'Resolve the incident' : 'Post the update'}
        </Button>
        {status === 'RESOLVED' ? <p className="pc-note pc-row-actions__note">Resolving is final. If it happens again, open a new incident.</p> : null}
      </div>
    </form>
  );
}

function Followup({ incident, canWrite, onSaved }: { incident: PlatformIncident; canWrite: boolean; onSaved: (i: PlatformIncident) => void }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const f = incident.followup;

  if (!canWrite)
    return f.what || f.actions ? (
      <div className="pc-notice-record">
        <h2 className="pc-subhead">Follow-up</h2>
        <dl className="pc-facts pc-facts--card">
          <div className="pc-suspended__note">
            <dt>What happened</dt>
            <dd className="pc-timeline__public">{f.what ?? 'Not written yet'}</dd>
          </div>
          <div className="pc-suspended__note">
            <dt>What we’re doing about it</dt>
            <dd className="pc-timeline__public">{f.actions ?? 'Not written yet'}</dd>
          </div>
        </dl>
      </div>
    ) : null;

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = data.get(name);
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    setBusy(true);
    setError(null);
    setSaved(false);
    stepUp(() => api<PlatformIncident>('PUT', `/incidents/${incident.id}/followup`, { what: text('what'), actions: text('actions') }, { ifMatch: `"v${String(incident.version)}"` }))
      .then((r) => {
        if (!r) return;
        onSaved(r);
        setSaved(true);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form method="post" className="pc-form pc-incident-form" onSubmit={submit} noValidate aria-labelledby="followup-title">
      <h2 id="followup-title" className="pc-subhead">
        Follow-up
      </h2>
      <p className="pc-note">Staff only. What happened, and what’s being done so it doesn’t again. Feeds the incident register (S11).</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {saved ? <Notice tone="success">Follow-up saved.</Notice> : null}
      <div className="uv-field">
        <label className="uv-field__label" htmlFor="followup-what">
          What happened
        </label>
        <textarea id="followup-what" name="what" className="uv-field__input pc-textarea" rows={4} maxLength={4000} defaultValue={f.what ?? ''} />
      </div>
      <div className="uv-field">
        <label className="uv-field__label" htmlFor="followup-actions">
          What we’re doing about it
        </label>
        <textarea id="followup-actions" name="actions" className="uv-field__input pc-textarea" rows={4} maxLength={4000} defaultValue={f.actions ?? ''} />
      </div>
      <div className="pc-row-actions pc-row-actions--start">
        <Button type="submit" variant="quiet" pending={busy}>
          Save the follow-up
        </Button>
      </div>
    </form>
  );
}
