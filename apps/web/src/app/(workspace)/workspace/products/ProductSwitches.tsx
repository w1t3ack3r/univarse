'use client';

import { Button, Card, Notice, ShieldCheck } from '@univarse/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, unwrap, type ResponseBody } from '@/lib/client-api';

/** Generated from the API contract (spec 0011): `product` is one of the catalog's keys. */
export type ProductState = ResponseBody<'/api/v1/admin/products/{product}', 'put'>;

const LABEL: Record<string, { name: string; about: string }> = {
  core: { name: 'Core', about: 'Accounts, sign-in, roles and settings. Always on.' },
  admissions: { name: 'Admissions', about: 'Applications, screening, offers and acceptance.' },
  bursary: { name: 'Bursary', about: 'Fees, invoices, payments and receipts.' },
  academics: { name: 'Academics', about: 'Courses, registration, score sheets and results.' },
  teaching: { name: 'Teaching & Learning', about: 'Course pages, materials, assignments and live engagement.' },
  assessment: { name: 'Assessment', about: 'CA tests by computer, question banks and marking.' },
  student_affairs: { name: 'Student Affairs', about: 'Hostels, clearance and student records.' },
  helpdesk: { name: 'Helpdesk', about: 'Announcements and support between users and the ICT unit.' },
  reporting: { name: 'Reporting', about: 'Dashboards and reports for management.' },
};

/** W14 in use: every switch is a sensitive action, so a 428 opens step-up and retries once. */
export function ProductSwitches({ initial }: { initial: ProductState[] }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function toggle(p: ProductState) {
    setBusy(p.product);
    setError(null);
    try {
      const next = await withStepUp(() =>
        unwrap(client.PUT('/api/v1/admin/products/{product}', { params: { path: { product: p.product } }, body: { enabled: !p.enabled } })),
      );
      if (next) {
        setItems((all) => all.map((x) => (x.product === next.product ? next : x)));
        router.refresh(); // navigation follows active products
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <ul className="list">
        {items.map((p) => {
          const label = LABEL[p.product] ?? { name: p.product, about: '' };
          const core = p.product === 'core';
          return (
            <li key={p.product} className="list__row">
              <span className="list__text">
                <span className="list__title" id={`p-${p.product}`}>
                  {label.name}
                </span>
                <span className="list__meta">{p.entitled ? label.about : 'Not in your plan. Contact UniVarse to add it.'}</span>
              </span>
              {core ? (
                <span className="status status--on">Always on</span>
              ) : p.entitled ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.enabled}
                  aria-labelledby={`p-${p.product}`}
                  className="switch"
                  disabled={busy !== null}
                  aria-busy={busy === p.product || undefined}
                  onClick={() => void toggle(p)}
                >
                  <span className="switch__track">
                    <span className="switch__thumb" />
                  </span>
                  <span className="switch__text">{p.enabled ? 'On' : 'Off'}</span>
                </button>
              ) : (
                <span className="status status--off">Not in plan</span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The page loaded with 428: ask once, then reload the server data. */
export function ConfirmToContinue() {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Card>
      <div className="done">
        <span className="uv-icon-tile">
          <ShieldCheck />
        </span>
        <h2 className="auth__heading">Confirm it’s you to manage products</h2>
        <p className="auth__sub">Switching products on or off changes what everyone at your institution can use.</p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <Button
          onClick={() => {
            setError(null);
            withStepUp(() => unwrap(client.GET('/api/v1/admin/products')))
              .then((ok) => {
                if (ok) router.refresh();
              })
              .catch((err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined)));
          }}
        >
          Confirm it’s me
        </Button>
      </div>
    </Card>
  );
}
