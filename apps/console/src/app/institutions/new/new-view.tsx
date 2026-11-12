'use client';

import { NIGERIAN_STATES } from '@univarse/contracts';
import { PROVISIONING_STEPS, slugProblem, templateForType, type TenantTypeName } from '@univarse/domain';
import { Button, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type SubmitEvent } from 'react';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, field, type ApiError } from '../../../lib/api';
import { OWNERSHIP, PRODUCT, TEMPLATE, TYPE } from '../labels';
import { StepTrack } from '../step-track';

const OPTIONAL_PRODUCTS = Object.keys(PRODUCT).filter((p) => p !== 'core');

interface Created {
  readonly tenantId: string;
  readonly jobId: string;
}

/**
 * Spec 0034 Q13: creating an institution. Three groups (the institution, its first administrator, its products), and
 * beside them what will happen. One request, sent with an idempotency key made when the form opened, so a retried or
 * double submit makes one institution (Q12). Creating asks for step-up; the administrator's details go no further than
 * the sealed invite (Q7).
 */
export function NewInstitutionView() {
  const me = useMe();
  const router = useRouter();
  const stepUp = useStepUp();
  const key = useRef<string>(crypto.randomUUID());
  const [type, setType] = useState('UNIVERSITY');
  const [template, setTemplate] = useState('university');
  const [templateChosen, setTemplateChosen] = useState(false);
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  if (!me.permissions.includes('platform.tenant.provision')) return <NothingHere />;

  // Said once there's enough to judge, not on the first keystroke.
  // The platform's own rule (Q-B9), so a mistake shows before anything is sent.
  const problem = slug.length < 3 ? null : slugProblem(slug);
  const slugHint = problem === 'format' ? 'Use 3 to 40 lower-case letters, digits and single hyphens, starting with a letter.' : problem === 'reserved' ? 'That subdomain is kept for UniVarse’s own use. Choose another.' : null;
  const onType = (value: string) => {
    setType(value);
    // The type proposes its template (Q6) until one is chosen by hand.
    if (!templateChosen) setTemplate(templateForType(value as TenantTypeName));
  };

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = {
      slug: field(data, 'slug'),
      legalName: field(data, 'legalName'),
      shortName: field(data, 'shortName'),
      type,
      ownership: field(data, 'ownership'),
      template,
      state: field(data, 'state') || null,
      products: data.getAll('products').filter((p): p is string => typeof p === 'string'),
      admin: { displayName: field(data, 'adminName'), email: field(data, 'adminEmail'), username: field(data, 'adminUsername') },
    };
    setBusy(true);
    setError(null);
    setFields({});
    stepUp(() => api<Created>('POST', '/tenants', body, { idempotencyKey: key.current }))
      .then((created) => {
        if (created) router.push(`/institutions/${created.tenantId}`);
      })
      .catch((err: unknown) => {
        const failed = asApiError(err);
        setError(failed);
        // A field the API named gets the message beside it; the rest stays in the notice above.
        const byField: Record<string, string> = {};
        for (const f of failed.fieldErrors) byField[f.path.split('.').at(-1) ?? f.path] = failed.message;
        if (failed.code === 'tenant.slug_taken') byField.slug = failed.message;
        setFields(byField);
        // A refused request was never recorded: the next try is a new one.
        if (failed.status >= 400 && failed.status < 500) key.current = crypto.randomUUID();
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="pc-section" aria-labelledby="new-title">
      <p className="pc-note">
        <Link className="uv-link" href="/institutions">
          All institutions
        </Link>
      </p>
      <div className="pc-section__head">
        <div>
          <h1 id="new-title" className="pc-section__title">
            New institution
          </h1>
          <p className="pc-section__lead">Its record, its first administrator and its products. UniVarse sets the rest up, and you can watch it happen.</p>
        </div>
      </div>

      <div className="pc-compose">
        <form method="post" className="pc-compose__form" onSubmit={submit} noValidate aria-describedby={error ? 'new-error' : undefined}>
          {error ? (
            <div id="new-error">
              <Notice requestId={error.requestId}>{error.message}</Notice>
            </div>
          ) : null}

          <fieldset className="pc-group">
            <legend className="pc-group__title">The institution</legend>
            <TextField label="Legal name" name="legalName" autoComplete="off" required minLength={3} maxLength={200} error={fields.legalName} />
            <div className="pc-group__pair">
              <TextField label="Short name" name="shortName" autoComplete="off" required minLength={2} maxLength={40} hint="As staff and students say it: UNILAG." error={fields.shortName} />
              <TextField
                label="Subdomain"
                name="slug"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={40}
                value={slug}
                onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
                hint="The first part of its web address. It can’t change later."
                error={fields.slug ?? slugHint ?? undefined}
              />
            </div>
            <div className="pc-group__pair">
              <div className="uv-field">
                <label className="uv-field__label" htmlFor="new-type">
                  Type
                </label>
                <select id="new-type" className="uv-field__input pc-select" value={type} onChange={(e) => onType(e.target.value)}>
                  {Object.entries(TYPE).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="uv-field">
                <label className="uv-field__label" htmlFor="new-ownership">
                  Ownership
                </label>
                <select id="new-ownership" name="ownership" className="uv-field__input pc-select" defaultValue="FEDERAL">
                  {Object.entries(OWNERSHIP).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="pc-group__pair">
              <div className="uv-field">
                <label className="uv-field__label" htmlFor="new-state">
                  State
                </label>
                <select id="new-state" name="state" className="uv-field__input pc-select" defaultValue="">
                  <option value="">Record it later</option>
                  {NIGERIAN_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="uv-field">
                <label className="uv-field__label" htmlFor="new-template">
                  Template
                </label>
                <select
                  id="new-template"
                  className="uv-field__input pc-select"
                  value={template}
                  aria-describedby="new-template-about"
                  onChange={(e) => {
                    setTemplate(e.target.value);
                    setTemplateChosen(true);
                  }}
                >
                  {Object.entries(TEMPLATE).map(([value, t]) => (
                    <option key={value} value={value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <p id="new-template-about" className="uv-field__hint">
                  {TEMPLATE[template]?.about}
                </p>
              </div>
            </div>
          </fieldset>

          <fieldset className="pc-group">
            <legend className="pc-group__title">Its first administrator</legend>
            <p className="pc-group__lead">Usually the head of its ICT unit. They’re emailed an invitation and set up their own password and authenticator.</p>
            <TextField label="Full name" name="adminName" autoComplete="off" required minLength={2} maxLength={80} error={fields.displayName} />
            <div className="pc-group__pair">
              <TextField label="Email" name="adminEmail" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={254} error={fields.email} />
              <TextField label="Username" name="adminUsername" autoComplete="off" autoCapitalize="characters" spellCheck={false} required maxLength={40} hint="They sign in with this: letters, digits, slashes, dots, hyphens." error={fields.username} />
            </div>
          </fieldset>

          <fieldset className="pc-group">
            <legend className="pc-group__title">Products</legend>
            <p className="pc-group__lead">Core is always on. Granted products are switched on by the institution’s administrator when they’re ready.</p>
            <div className="pc-choices">
              <label className="pc-check" data-locked="true">
                <input type="checkbox" checked disabled />
                <span>
                  <strong>Core</strong>
                  <span className="pc-note">{PRODUCT.core?.about}</span>
                </span>
              </label>
              {OPTIONAL_PRODUCTS.map((p) => (
                <label key={p} className="pc-check">
                  <input type="checkbox" name="products" value={p} />
                  <span>
                    <strong>{PRODUCT[p]?.name}</strong>
                    <span className="pc-note">{PRODUCT[p]?.about}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="pc-compose__submit">
            <Button type="submit" pending={busy}>
              Create the institution
            </Button>
            <p className="pc-note">You’ll be asked for your authenticator code.</p>
          </div>
        </form>

        <aside className="pc-compose__aside" aria-labelledby="new-next">
          <h2 id="new-next" className="pc-compose__aside-title">
            What happens next
          </h2>
          <p className="pc-note">Eight steps, usually under a minute. You’ll see each one finish, and resume from any that stops.</p>
          <StepTrack label="The steps of provisioning" steps={PROVISIONING_STEPS.map((step) => ({ step, status: 'PENDING' }))} />
        </aside>
      </div>
    </section>
  );
}
