'use client';

import { Button, buttonClass, Card, Check, Notice } from '@univarse/ui';
import { CodeField, PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

/**
 * Spec 0032 Q7: an administrator corrected this person's address. They're signed out, perhaps locked out of the old
 * mailbox, so the code proves the new address and their own password proves it's them.
 */
export function ConfirmForm() {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setRefused(false);
    unwrap(client.POST('/api/v1/auth/contact-change/confirm', { body: { username: textField(data, 'username'), code, password: textField(data, 'password') } }))
      .then(() => setDone(true))
      .catch((err: unknown) => {
        const failed = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
        if (failed.code === 'contact.code_invalid') setRefused(true);
        else setError(failed);
      })
      .finally(() => setPending(false));
  };

  if (done) {
    return (
      <Card>
        <span className="uv-icon-tile">
          <Check />
        </span>
        <h1 className="auth__heading">Your address is changed</h1>
        <p className="auth__sub">Your sessions were signed out. Sign in as usual.</p>
        <Link className={buttonClass('action', true)} href="/login">
          Sign in
        </Link>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <h1 className="auth__heading">Confirm a new address</h1>
        <p className="auth__sub">Your institution corrected your address. Enter the code sent to the new one, and your password.</p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        {refused ? <Notice>That didn’t work. Check your number, the code and your password. A code lasts 15 minutes.</Notice> : null}
        <form method="post" className="auth__form" onSubmit={onSubmit} noValidate>
          <TextField label="Matric or staff number" name="username" autoComplete="username" autoCapitalize="characters" spellCheck={false} required />
          <CodeField label="Code from the email" value={code} onChange={setCode} />
          <PasswordField label="Your password" name="password" autoComplete="current-password" required />
          <div className="auth__actions">
            <Button type="submit" block pending={pending} disabled={code.length !== 6}>
              {pending ? 'Confirming…' : 'Confirm this address'}
            </Button>
          </div>
        </form>
      </Card>
      <div className="auth__more">
        <p>
          <Link className="uv-link" href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    </>
  );
}
