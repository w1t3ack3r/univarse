'use client';

import type { PlatformGoLive } from '@univarse/contracts';
import { Button, Check, ChevronDown, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, field, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { GO_LIVE } from '../labels';
import type { Changing, Tenant } from './institution-view';

/** Where each item is fixed on this page. The administrator's item has nothing to fix here: it's theirs to do. */
const FIX: Readonly<Record<string, { href: string; text: string } | undefined>> = {
  products: { href: '#t-products', text: 'Products' },
  branding: { href: '#t-branding', text: 'Branding' },
  regulatory: { href: '#t-regulatory', text: 'Regulatory details' },
  dpa: { href: '#t-dpa', text: 'the form below' },
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Spec 0034 Q9, Q10: going live. Every item is computed by the platform, never ticked here, except the DPA, which is
 * recorded below. "Take it live" works only when every item passes, and asks for step-up; the platform decides again
 * when it's pressed. Shown only while the institution is onboarding.
 */
export function GoLiveSection({ tenant, canGoLive, changing }: { tenant: Tenant; canGoLive: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [view, setView] = useState<PlatformGoLive | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'dpa' | 'live' | null>(null);
  const [dpaOpen, setDpaOpen] = useState(false);

  const load = useCallback(() => {
    api<PlatformGoLive>('GET', `/tenants/${tenant.id}/go-live`)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((err: unknown) => setError(asApiError(err)));
  }, [tenant.id]);
  // Read again whenever the institution changes: a product, a colour or the regulatory details tick an item.
  useEffect(load, [load, tenant]);

  if (!view) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null;
  const passed = view.items.filter((i) => i.passed).length;

  const recordDpa = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = { dpaVersion: field(data, 'dpaVersion'), signedOn: field(data, 'signedOn'), reference: field(data, 'reference') };
    setBusy('dpa');
    stepUp(async () => {
      await api('PUT', `/tenants/${tenant.id}/dpa`, body);
      return true;
    })
      .then((ok) => {
        if (!ok) return;
        setDpaOpen(false);
        load();
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(null));
  };

  const goLive = () => {
    setBusy('live');
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/go-live`);
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is live. Its people can now use UniVarse at ${tenant.domains[0]?.hostname ?? 'its address'}.`);
      })
      .catch((err: unknown) => {
        setError(asApiError(err));
        load();
      })
      .finally(() => setBusy(null));
  };

  return (
    <section className="pc-section" aria-labelledby="t-golive">
      <div className="pc-section__head">
        <div>
          <h2 id="t-golive" className="pc-section__title">
            Going live
          </h2>
          <p className="pc-section__lead">
            {view.ready ? 'Everything is in place.' : `${String(passed)} of ${String(view.items.length)} done. Each item is checked by the platform as things change.`}
          </p>
        </div>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <ul className="pc-review pc-golive">
        {view.items.map((i) => {
          const text = GO_LIVE[i.item] ?? { label: i.item, todo: '', done: '' };
          const fix = FIX[i.item];
          return (
            <li key={i.item} className="pc-review__row pc-golive__row" data-passed={i.passed}>
              <span className="pc-golive__mark" aria-hidden="true">
                {i.passed ? <Check size={14} /> : null}
              </span>
              <div className="pc-review__who">
                <p className="pc-member__name">{text.label}</p>
                <p className="pc-note">
                  {i.passed ? text.done : text.todo}
                  {!i.passed && fix && canGoLive ? (
                    <>
                      {' '}
                      <a className="uv-link pc-golive__fix" href={fix.href}>
                        {fix.text}
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
              <span className={`pc-status ${i.passed ? 'pc-status--on' : 'pc-status--none'}`}>{i.passed ? 'Done' : 'To do'}</span>
            </li>
          );
        })}
      </ul>

      <div className="pc-golive__dpa" id="t-dpa">
        <h3 className="pc-subhead">Data processing agreement</h3>
        {view.dpa ? (
          <p className="pc-note">
            Version {view.dpa.dpaVersion}, signed {view.dpa.signedOn}, reference {view.dpa.reference}. Recorded {when(view.dpa.recordedAt)}.
          </p>
        ) : (
          <p className="pc-note">Not recorded yet. An institution can’t go live before UniVarse is its processor on paper.</p>
        )}
        {canGoLive ? (
          <details className="pc-disclosure" open={dpaOpen} onToggle={(e) => setDpaOpen(e.currentTarget.open)}>
            <summary className="uv-link">
              {view.dpa ? 'Record a newer one' : 'Record the signed agreement'}
              <ChevronDown size={18} />
            </summary>
            <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={recordDpa} noValidate>
              <TextField label="Agreement version" name="dpaVersion" autoComplete="off" required maxLength={40} hint="As printed on it, for example v1.2." />
              <TextField label="Date signed" name="signedOn" type="date" max={today()} required />
              <TextField label="Reference" name="reference" autoComplete="off" required minLength={3} maxLength={200} hint="The signed copy’s name or number, so it can be found. No one’s personal details." />
              <div className="pc-row-actions pc-row-actions--start">
                <Button type="submit" variant="quiet" pending={busy === 'dpa'}>
                  Record the agreement
                </Button>
              </div>
            </form>
          </details>
        ) : null}
      </div>

      {canGoLive ? (
        <div className="pc-golive__go">
          <Button type="button" disabled={!view.ready} pending={busy === 'live'} onClick={goLive} aria-describedby="t-golive-why">
            Take {tenant.shortName} live
          </Button>
          <p id="t-golive-why" className="pc-note">
            {view.ready ? 'Its people can use UniVarse from then on. You’ll be asked for your authenticator code.' : 'Available once every item above is done.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
