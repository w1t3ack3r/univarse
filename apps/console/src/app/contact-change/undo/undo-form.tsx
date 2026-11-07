'use client';

import { Button, buttonClass, Check, Lock, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../../components/auth-panel';
import { api, ApiError, asApiError, field } from '../../../lib/api';

/**
 * Spec 0032 Q6: someone's address was changed and it wasn't them. The code came to the old address, and works for 72
 * hours, signed out, because an intruder may hold the account. Undoing restores the address and ends every session.
 */
export function UndoForm() {
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
    api('POST', '/auth/contact-change/undo', { email: field(data, 'email'), code: field(data, 'code') })
      .then(() => setDone(true))
      .catch((err: unknown) => {
        const failed = asApiError(err);
        if (failed.code === 'contact.undo_invalid') setRefused(true);
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
        <h1 className="pc-card__title">Your address is back</h1>
        <p className="pc-card__lead">Every session on your account was signed out. Your old password no longer works, so set a new one before you sign in.</p>
        <Link className={buttonClass('action', true)} href="/reset-password">
          Set a new password
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
        <Lock />
      </span>
      <h1 className="pc-card__title">Undo an address change</h1>
      <p className="pc-card__lead">If your address was changed and it wasn’t you, use the code from the email we sent to your old address. It works for 72 hours.</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {refused ? <Notice>That didn’t work. Check the address and the code. A code stops working after 72 hours.</Notice> : null}
      <form method="post" className="pc-form" onSubmit={onSubmit} noValidate>
        <TextField label="Your old email address" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <TextField label="Undo code" name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
        <div className="pc-actions">
          <Button type="submit" block pending={pending}>
            {pending ? 'Undoing…' : 'Undo the change'}
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
