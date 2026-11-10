'use client';

import { Button, ChevronDown } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, field } from '../../../lib/api';
import { PRODUCT } from '../labels';
import type { Changing, Tenant } from './institution-view';

type Product = Tenant['products'][number];

/**
 * Spec 0033 Q13, Q14: a product is granted by UniVarse and switched on by the institution. Granting asks why. Revoking
 * also asks for the subdomain typed out, because it takes a product away from people using it. It deletes nothing, and
 * granting it back restores it.
 */
export function ProductsSection({ tenant, canEntitle, changing }: { tenant: Tenant; canEntitle: boolean; changing: Changing }) {
  return (
    <section className="pc-section" aria-labelledby="t-products">
      <h2 id="t-products" className="pc-section__title">
        Products
      </h2>
      <ul className="pc-review">
        {tenant.products.map((p) => (
          <ProductRow key={p.product} tenant={tenant} product={p} canEntitle={canEntitle} changing={changing} />
        ))}
      </ul>
    </section>
  );
}

function ProductRow({ tenant, product: p, canEntitle, changing }: { tenant: Tenant; product: Product; canEntitle: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const label = PRODUCT[p.product] ?? { name: p.product, about: '' };
  const state = p.alwaysOn ? { text: 'Always on', tone: 'pc-status--on' } : !p.entitled ? { text: 'Not granted', tone: 'pc-status--none' } : p.enabled ? { text: 'On', tone: 'pc-status--on' } : { text: 'Granted, not switched on', tone: 'pc-status--wait' };

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const entitled = !p.entitled;
    const body = { entitled, reason: field(data, 'reason'), ...(entitled ? {} : { confirmSlug: field(data, 'confirm') }) };
    setBusy(true);
    stepUp(async () => {
      await api('PUT', `/tenants/${tenant.id}/products/${p.product}`, body);
      return true;
    })
      .then((ok) => {
        if (!ok) return; // the step-up was cancelled
        setOpen(false);
        changing.changed(entitled ? `${label.name} is granted. The institution’s IT Admin can now switch it on.` : `${label.name} is revoked. Nothing was deleted, and granting it back restores it.`);
      })
      .catch(changing.failed)
      .finally(() => setBusy(false));
  };

  return (
    <li className="pc-review__row">
      <div className="pc-review__who">
        <p className="pc-member__name">{label.name}</p>
        <p className="pc-note">{label.about}</p>
      </div>
      <span className={`pc-status ${state.tone}`}>{state.text}</span>
      {canEntitle && !p.alwaysOn ? (
        <details className="pc-disclosure pc-product__action" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="uv-link">
            {p.entitled ? 'Revoke' : 'Grant'}
            <ChevronDown size={18} />
          </summary>
          <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={submit} noValidate>
            <div className="uv-field">
              <label className="uv-field__label" htmlFor={`reason-${p.product}`}>
                Why?
              </label>
              <textarea id={`reason-${p.product}`} name="reason" className="uv-field__input pc-textarea" rows={2} minLength={5} maxLength={500} required />
              <p className="pc-note">Kept in the audit log. Don’t include anyone’s personal details.</p>
            </div>
            {p.entitled ? <TextField label={`Type ${tenant.slug} to confirm`} name="confirm" autoComplete="off" autoCapitalize="none" spellCheck={false} required /> : null}
            <div className="pc-row-actions pc-row-actions--start">
              <Button type="submit" variant="quiet" className={p.entitled ? 'pc-danger' : undefined} pending={busy}>
                {p.entitled ? `Revoke ${label.name}` : `Grant ${label.name}`}
              </Button>
            </div>
          </form>
        </details>
      ) : null}
    </li>
  );
}
