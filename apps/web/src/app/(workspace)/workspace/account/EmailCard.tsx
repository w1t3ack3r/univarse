'use client';

import { Button, Card, Mail, Notice } from '@univarse/ui';
import { CodeField, TextField } from '@univarse/ui/client';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

const failure = (err: unknown) => (err instanceof ApiError ? err : new ApiError(0, undefined, undefined));

/**
 * Your address (spec 0032 Q2): a step-up, then a code sent to the new address. Nothing changes until it's confirmed, so a
 * typo can't lock anyone out. The answer is the same whether or not the address is free (Q4).
 */
export function EmailCard({ address, pending }: { address: string | null; pending: string | null }) {
  const withStepUp = useStepUp();
  const [current, setCurrent] = useState(address);
  const [sentTo, setSentTo] = useState(pending);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  const request = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = textField(new FormData(form), 'email').trim().toLowerCase();
    setBusy(true);
    setError(null);
    setChanged(false);
    withStepUp(() => unwrap(client.POST('/api/v1/auth/email', { body: { email } })))
      .then((r) => {
        if (r === undefined) return;
        setSentTo(email);
        form.reset();
      })
      .catch((err: unknown) => setError(failure(err)))
      .finally(() => setBusy(false));
  };

  const confirm = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCodeError(undefined);
    unwrap(client.POST('/api/v1/auth/email/confirm', { body: { code } }))
      .then(() => {
        setCurrent(sentTo);
        setSentTo(null);
        setCode('');
        setChanged(true);
      })
      .catch((err: unknown) => {
        const failed = failure(err);
        if (failed.code === 'contact.code_invalid') setCodeError('That code isn’t right, or it has expired. Ask for a new one.');
        else setError(failed);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <div className="auth__form">
      <span className="uv-icon-tile">
        <Mail />
      </span>
      <h2 className="auth__heading">Your email address</h2>
      <p className="auth__sub">{current ? <>Security notices and password resets go to <strong>{current}</strong>.</> : 'You have no address on your account yet. Without one, you can’t reset your password.'}</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {changed ? <Notice tone="success">Your address is changed. Your other sessions were signed out.</Notice> : null}
      {sentTo ? (
        <form method="post" className="auth__form" onSubmit={confirm} noValidate>
          <p className="auth__sub">We sent a code to {sentTo}. It lasts 15 minutes. Your address stays as it is until you enter it.</p>
          <CodeField
            label="Code from the email"
            value={code}
            onChange={(v) => {
              setCode(v);
              setCodeError(undefined);
            }}
            error={codeError}
          />
          <div className="auth__actions">
            <Button type="submit" pending={busy} disabled={code.length !== 6}>
              Confirm this address
            </Button>
            <Button
              type="button"
              variant="quiet"
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
        <form method="post" className="auth__form" onSubmit={request} noValidate>
          <TextField label="New email address" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required />
          <div className="auth__actions">
            <Button type="submit" variant="quiet" pending={busy}>
              Send a code
            </Button>
          </div>
        </form>
      )}
      </div>
    </Card>
  );
}
