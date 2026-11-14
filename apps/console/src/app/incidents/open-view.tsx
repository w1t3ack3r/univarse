'use client';

import type { PlatformIncident } from '@univarse/contracts';
import { ArrowLeft, Button, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { useStepUp } from '../../components/step-up';
import { api, asApiError, type ApiError } from '../../lib/api';
import { INCIDENT_PROBLEM, PERSONAL_DATA, SEVERITY } from '../../lib/incidents';
import { fromLagosInput, toLagosInput } from '../../lib/notices';
import { ChooseInstitutions } from '../notices/notice-editor';

type Severity = PlatformIncident['severity'];
type PersonalData = PlatformIncident['personalData'];

/**
 * Spec 0037 Q13: opening an incident. What it is, how bad, whom it affects, when it started and when we knew, whether
 * personal data may be involved, then what institutions are told first and a note for staff. Opening shows it at the
 * affected institutions at once; it asks for a step-up.
 */
export function OpenIncidentView() {
  const me = useMe();
  const router = useRouter();
  const stepUp = useStepUp();
  const now = new Date().toISOString();
  const [severity, setSeverity] = useState<Severity>('SEV3');
  const [personal, setPersonal] = useState<PersonalData>('UNKNOWN');
  const [scope, setScope] = useState<'ALL' | 'TENANTS'>('TENANTS');
  const [chosen, setChosen] = useState<{ id: string; slug: string; name: string }[]>([]);
  const [startedAt, setStartedAt] = useState(toLagosInput(now));
  const [awareAt, setAwareAt] = useState(toLagosInput(now));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (!me.permissions.includes('platform.incident.manage')) return <NothingHere />;
  const problem = (path: string) => error?.fieldErrors.filter((e) => e.path === path).map((e) => INCIDENT_PROBLEM[e.code] ?? e.code)[0];

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = data.get(name);
      return typeof v === 'string' ? v : '';
    };
    const body = {
      title: text('title'),
      severity,
      scope,
      ...(scope === 'TENANTS' ? { tenantIds: chosen.map((t) => t.id) } : {}),
      personalData: personal,
      startedAt: fromLagosInput(startedAt) ?? '',
      awareAt: fromLagosInput(awareAt) ?? '',
      publicText: text('publicText'),
      internalNote: text('internalNote').trim() || null,
    };
    setBusy(true);
    setError(null);
    stepUp(() => api<PlatformIncident>('POST', '/incidents', body))
      .then((r) => {
        if (r) router.push(`/incidents/${r.id}`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="pc-section" aria-labelledby="open-title">
      <Link className="uv-link pc-back" href="/incidents">
        <ArrowLeft size={18} />
        Incidents
      </Link>
      <h1 id="open-title" className="pc-section__title">
        Open an incident
      </h1>
      <p className="pc-section__lead">It shows at the institutions it affects as soon as it’s open. Say what people notice, not the cause.</p>
      <form method="post" className="pc-form pc-incident-form" onSubmit={submit} noValidate>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <TextField label="What’s wrong" name="title" maxLength={120} hint="One line, as institutions will read it." error={problem('title')} required />
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Severity</legend>
          <div className="pc-seg pc-seg--choice">
            {(Object.keys(SEVERITY) as Severity[]).map((s) => (
              <label key={s} className="pc-seg__opt" data-on={severity === s ? 'true' : undefined}>
                <input type="radio" name="severity" value={s} checked={severity === s} onChange={() => setSeverity(s)} />
                {SEVERITY[s].label}
              </label>
            ))}
          </div>
          <p className="pc-note">{SEVERITY[severity].about}</p>
        </fieldset>
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Which institutions</legend>
          <div className="pc-choices">
            {(
              [
                ['TENANTS', 'Chosen institutions', 'Pick them below.'],
                ['ALL', 'Every institution', 'Every institution with people, suspended ones too.'],
              ] as const
            ).map(([value, label, about]) => (
              <label key={value} className="pc-check">
                <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} />
                <span>
                  <strong>{label}</strong>
                  <span className="pc-note">{about}</span>
                </span>
              </label>
            ))}
          </div>
          {scope === 'TENANTS' ? <ChooseInstitutions chosen={chosen} onChange={setChosen} problem={problem('tenantIds')} /> : null}
        </fieldset>
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">When, in Nigerian time</legend>
          <div className="pc-notice-edit__window">
            <TextField label="It started" type="datetime-local" name="startedAt" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} error={problem('startedAt')} />
            <TextField label="We knew" type="datetime-local" name="awareAt" value={awareAt} onChange={(e) => setAwareAt(e.target.value)} error={problem('awareAt')} />
          </div>
        </fieldset>
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Could personal data be involved?</legend>
          <div className="pc-seg pc-seg--choice">
            {(['UNKNOWN', 'YES', 'NO'] as const).map((p) => (
              <label key={p} className="pc-seg__opt" data-on={personal === p ? 'true' : undefined}>
                <input type="radio" name="personalData" value={p} checked={personal === p} onChange={() => setPersonal(p)} />
                {PERSONAL_DATA[p]}
              </label>
            ))}
          </div>
          <p className="pc-note">Unless it’s No, the 72-hour clock runs from when we knew. The institutions are the controllers: tell them; the system sends nothing itself.</p>
        </fieldset>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="incident-public">
            What institutions are told
          </label>
          <textarea id="incident-public" name="publicText" className="uv-field__input pc-textarea" rows={3} maxLength={1000} required aria-describedby="incident-public-hint" />
          <p id="incident-public-hint" className={problem('publicText') ? 'uv-field__error' : 'pc-note'}>
            {problem('publicText') ?? 'Shown to everyone at the affected institutions, as plain text.'}
          </p>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="incident-note">
            Internal note (optional)
          </label>
          <textarea id="incident-note" name="internalNote" className="uv-field__input pc-textarea" rows={3} maxLength={2000} aria-describedby="incident-note-hint" />
          <p id="incident-note-hint" className="pc-note">
            Staff only. Never shown at an institution.
          </p>
        </div>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" pending={busy}>
            Open the incident
          </Button>
        </div>
      </form>
    </section>
  );
}
