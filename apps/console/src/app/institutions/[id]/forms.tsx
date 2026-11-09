'use client';

import { NIGERIAN_STATES } from '@univarse/contracts';
import { Button } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, field } from '../../../lib/api';
import { OPERATING_STATUS, OWNERSHIP, TYPE } from '../labels';
import type { Changing, Tenant } from './institution-view';

const nullable = (v: string) => (v === '' ? null : v);

/** Spec 0033 Q5, Q6: `If-Match` on the version it loaded, so two staff can't silently overwrite each other. */
export function ProfileForm({ tenant, changing }: { tenant: Tenant; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = { legalName: field(data, 'legalName'), shortName: field(data, 'shortName'), ownership: field(data, 'ownership'), type: tenant.typeLocked ? tenant.type : field(data, 'type') };
    setBusy(true);
    stepUp(async () => {
      await api('PUT', `/tenants/${tenant.id}`, body, { ifMatch: `"v${String(tenant.version)}"` });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed('The profile is saved.');
      })
      .catch(changing.failed)
      .finally(() => setBusy(false));
  };
  return (
    <section className="pc-section" aria-labelledby="t-profile">
      <h2 id="t-profile" className="pc-section__title">
        Profile
      </h2>
      <form method="post" className="pc-form pc-form--narrow" onSubmit={submit} noValidate>
        <TextField label="Legal name" name="legalName" defaultValue={tenant.legalName} autoComplete="off" required />
        <TextField label="Short name" name="shortName" defaultValue={tenant.shortName} autoComplete="off" required />
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="t-ownership">
            Ownership
          </label>
          <select id="t-ownership" name="ownership" className="uv-field__input pc-select" defaultValue={tenant.ownership}>
            {Object.entries(OWNERSHIP).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="t-type">
            Type
          </label>
          <select id="t-type" name="type" className="uv-field__input pc-select" defaultValue={tenant.type} disabled={tenant.typeLocked} aria-describedby={tenant.typeLocked ? 't-type-why' : undefined}>
            {Object.entries(TYPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {tenant.typeLocked ? (
            <p id="t-type-why" className="pc-note">
              Locked: this institution is live, and its type decides its regulator and grading rules.
            </p>
          ) : null}
        </div>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" variant="quiet" pending={busy}>
            Save the profile
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Spec 0033 Q7: the regulator follows the type, so it's shown here and can't be typed. */
export function RegulatoryForm({ tenant, changing }: { tenant: Tenant; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const r = tenant.regulatory;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = { operatingStatus: field(data, 'operatingStatus'), state: nullable(field(data, 'state')), regulatorReference: nullable(field(data, 'regulatorReference')), jambCode: nullable(field(data, 'jambCode')) };
    setBusy(true);
    stepUp(async () => {
      await api('PUT', `/tenants/${tenant.id}/regulatory`, body, { ifMatch: `"v${String(r.version)}"` });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed('The regulatory details are saved.');
      })
      .catch(changing.failed)
      .finally(() => setBusy(false));
  };
  return (
    <section className="pc-section" aria-labelledby="t-regulatory">
      <h2 id="t-regulatory" className="pc-section__title">
        Regulatory details
      </h2>
      <p className="pc-section__lead">
        Regulated by <strong>{r.regulator}</strong>, which follows from its type.
      </p>
      <form method="post" className="pc-form pc-form--narrow" onSubmit={submit} noValidate>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="r-status">
            Operating status
          </label>
          <select id="r-status" name="operatingStatus" className="uv-field__input pc-select" defaultValue={r.operatingStatus}>
            {Object.entries(OPERATING_STATUS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="uv-field">
          <label className="uv-field__label" htmlFor="r-state">
            State
          </label>
          <select id="r-state" name="state" className="uv-field__input pc-select" defaultValue={r.state ?? ''}>
            <option value="">Not recorded</option>
            {NIGERIAN_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <TextField label="Regulator’s reference" name="regulatorReference" defaultValue={r.regulatorReference ?? ''} autoComplete="off" maxLength={120} />
        <TextField label="JAMB institution code" name="jambCode" defaultValue={r.jambCode ?? ''} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={16} hint="Letters and digits only." />
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" variant="quiet" pending={busy}>
            Save the regulatory details
          </Button>
        </div>
      </form>
    </section>
  );
}
