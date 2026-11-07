'use client';

import { Button, buttonClass, Check, Mail, Notice } from '@univarse/ui';
import { CodeField, PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../components/auth-panel';
import { api, ApiError, asApiError, field, secretField } from '../../lib/api';

/**
 * Spec 0032 Q7: an owner corrected this person's address. They're signed out, perhaps locked out of the old mailbox, so
 * the code proves the new address and their own password proves it's them. No administrator can finish this alone.
 */
export function ConfirmForm() {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [refused, setRefused] = useState(false);

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setRefused(false);
    api('POST', '/auth/contact-change/confirm', { email: field(data, 'email'), code, password: secretField(data, 'password') })
      .then(() => setDone(true))
      .catch((err: unknown) => {
        const failed = asApiError(err);
        if (failed.code === 'contact.code_invalid') setRefused(true);
        else setError(failed);
      })
      .finally(() => setPending(false));
  };

  if (done) {
    return (
      <AuthPanel>
        <span className="uv-icon-tile">
          <Check />
        </span>
        <h1 className="pc-card__title">Your address is changed</h1>
        <p className="pc-card__lead">Sign in with your new address, your password and your authenticator app.</p>
        <Link className={buttonClass('action', true)} href="/sign-in">
          Sign in
        </Link>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      below={
        <p>
          <Link className="uv-link" href="/sign-in">
            Back to sign in
          </Link>
        </p>
      }
    >
      <span className="uv-icon-tile">
        <Mail />
      </span>
      <h1 className="pc-card__title">Confirm a new address</h1>
      <p className="pc-card__lead">An owner corrected your address. Enter the code sent to the new one, and your password.</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {refused ? <Notice>That didn’t work. Check the address, the code and your password. A code lasts 15 minutes.</Notice> : null}
      <form method="post" className="pc-form" onSubmit={onSubmit} noValidate>
        <TextField label="Your new email address" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <CodeField label="Code from the email" value={code} onChange={setCode} />
        <PasswordField label="Your password" name="password" autoComplete="current-password" required />
        <div className="pc-actions">
          <Button type="submit" block pending={pending} disabled={code.length !== 6}>
            {pending ? 'Confirming…' : 'Confirm this address'}
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
