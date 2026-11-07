'use client';

import { Button, Notice } from '@univarse/ui';
import { CodeField, TextField } from '@univarse/ui/client';
import { useEffect, useState, type SubmitEvent } from 'react';
import { useMe } from '../../components/console-shell';
import { useStepUp } from '../../components/step-up';
import { api, ApiError, asApiError, field } from '../../lib/api';

/**
 * Your address (spec 0032 Q2, Q14): a step-up, then a code sent to the new address. Nothing changes until the code is
 * confirmed, so a typo can't lock anyone out. The answer is the same whether or not the address is free (Q4).
 */
export function EmailSection() {
  const me = useMe();
  const stepUp = useStepUp();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // A reload mid-change picks up where it left off.
  useEffect(() => {
    let live = true;
    api<{ pending: { address: string } | null }>('GET', '/me/email')
      .then((r) => {
        if (live && r.pending) setSentTo(r.pending.address);
      })
      .catch(() => undefined); // the form below still works
    return () => {
      live = false;
    };
  }, []);

  const request = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = field(new FormData(form), 'email');
    setBusy(true);
    setError(null);
    stepUp(() => api('POST', '/me/email', { email }))
      .then((r) => {
        if (r === undefined) return;
        setSentTo(email.toLowerCase());
        form.reset();
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };

  const confirm = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCodeError(undefined);
    api('POST', '/me/email/confirm', { code })
      // The whole page again: the header shows the address too. Nothing of it goes in the URL.
      .then(() => window.location.replace('/account?address=changed'))
      .catch((err: unknown) => {
        const failed = asApiError(err);
        if (failed.code === 'contact.code_invalid') setCodeError('That code isn’t right, or it has expired. Ask for a new one.');
        else setError(failed);
        setBusy(false);
      });
  };

  return (
    <section className="pc-section" aria-labelledby="email-title">
      <h2 id="email-title" className="pc-section__title">
        Your email address
      </h2>
      <p className="pc-section__lead">
        You sign in with <strong>{me.email}</strong>, and it’s where security notices and password resets go.
      </p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {sentTo ? (
        <form method="post" className="pc-form pc-form--narrow" onSubmit={confirm} noValidate>
          <p className="pc-note">
            We sent a code to {sentTo}. It lasts 15 minutes. Your address stays as it is until you enter it.
          </p>
          <CodeField
            label="Code from the email"
            value={code}
            onChange={(v) => {
              setCode(v);
              setCodeError(undefined);
            }}
            error={codeError}
          />
          <div className="pc-row-actions pc-row-actions--start">
            <Button type="submit" pending={busy} disabled={code.length !== 6}>
              Confirm this address
            </Button>
            <Button
              type="button"
              variant="plain"
              onClick={() => {
                setSentTo(null);
                setCode('');
              }}
            >
              Use a different address
            </Button>
          </div>
        </form>
      ) : (
        <form method="post" className="pc-form pc-form--narrow" onSubmit={request} noValidate>
          <TextField label="New email address" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required />
          <div className="pc-row-actions pc-row-actions--start">
            <Button type="submit" variant="quiet" pending={busy}>
              Send a code
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
