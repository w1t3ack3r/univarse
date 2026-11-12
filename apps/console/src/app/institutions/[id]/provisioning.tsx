'use client';

import type { PlatformProvisioning } from '@univarse/contracts';
import { Button, ChevronDown, Notice } from '@univarse/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { PROVISIONING_ERROR, STEP } from '../labels';
import { StepTrack } from '../step-track';
import type { Changing, Tenant } from './institution-view';

const POLL_MS = 2_000;

/**
 * Spec 0034 Q8, Q13: where a provisioning stands. While it runs the steps refresh every 2 seconds (paused while the tab
 * is hidden); when it finishes, the institution's page reloads, and the go-live checklist takes over. A stopped step
 * says what happened and what to check, and Resume starts again from it. An institution that was never provisioned
 * (the seed's) has no job, and nothing shows.
 */
export function ProvisioningSection({ tenant, canProvision, changing }: { tenant: Tenant; canProvision: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [view, setView] = useState<PlatformProvisioning | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const settled = useRef<string | null>(null);

  const load = useCallback(() => {
    api<PlatformProvisioning>('GET', `/tenants/${tenant.id}/provisioning`)
      .then((v) => {
        setError(null);
        setView(v);
      })
      .catch((err: unknown) => {
        const e = asApiError(err);
        if (e.status === 404) setNone(true);
        else setError(e);
      });
  }, [tenant.id]);

  useEffect(load, [load]);

  const running = view?.status === 'QUEUED' || view?.status === 'RUNNING';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  // Finished while watching: read the institution again (its status, host, products and key changed).
  useEffect(() => {
    if (!view) return;
    if (settled.current !== null && settled.current !== view.status && view.status === 'DONE') changing.changed(`${tenant.shortName} is provisioned. Its administrator has been invited.`);
    settled.current = view.status;
  }, [view, tenant.shortName, changing]);

  if (none || !view) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null;
  // Once done and live, the record of it is enough: the audit log holds every step.
  if (view.status === 'DONE' && tenant.status !== 'ONBOARDING') return null;

  const resume = () => {
    setBusy(true);
    stepUp(async () => {
      await api('POST', `/tenants/${tenant.id}/provisioning/resume`);
      return true;
    })
      .then((ok) => {
        if (ok) load();
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  const failedStep = view.error ? (STEP[view.error.step]?.label ?? view.error.step) : null;
  return (
    <section className="pc-section" aria-labelledby="t-provisioning">
      <div className="pc-section__head">
        <div>
          <h2 id="t-provisioning" className="pc-section__title">
            Provisioning
          </h2>
          <p className="pc-section__lead">
            {view.status === 'DONE'
              ? `Finished ${view.finishedAt ? when(view.finishedAt) : ''}, from the ${view.template} template. The invitation went to ${view.invite}.`
              : view.status === 'FAILED'
                ? `Stopped at “${failedStep ?? ''}”. Everything before it is done and stays done.`
                : `Setting it up from the ${view.template} template. The invitation will go to ${view.invite}.`}
          </p>
        </div>
      </div>
      {/* Announced politely as steps finish; the track itself isn't re-read every 2 seconds. */}
      <p className="uv-visually-hidden" aria-live="polite">
        {running ? `${String(view.steps.filter((s) => s.status === 'DONE').length)} of 8 steps done.` : ''}
      </p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {view.error ? (
        <div className="pc-stopped" role="alert">
          <Notice>{PROVISIONING_ERROR[view.error.code] ?? PROVISIONING_ERROR.unexpected}</Notice>
          {canProvision ? (
            <div className="pc-row-actions pc-row-actions--start">
              <Button type="button" pending={busy} onClick={resume}>
                Resume from “{failedStep}”
              </Button>
            </div>
          ) : (
            <p className="pc-note">An owner or super admin can resume it.</p>
          )}
        </div>
      ) : null}
      {view.status === 'DONE' ? (
        <details className="pc-disclosure">
          <summary className="uv-link">
            Show the steps
            <ChevronDown size={18} />
          </summary>
          <div className="pc-disclosure__body">
            <StepTrack label="Provisioning steps" steps={view.steps} />
          </div>
        </details>
      ) : (
        <StepTrack label="Provisioning steps" steps={view.steps} />
      )}
    </section>
  );
}
