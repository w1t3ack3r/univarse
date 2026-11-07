'use client';

import { Button, buttonClass, Card, Check, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

/**
 * Spec 0032 Q6: an address was changed and it wasn't this person. The code came to the old address and works for 72
 * hours, signed out, because an intruder may hold the account.
 */
export function UndoForm() {
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
    unwrap(client.POST('/api/v1/auth/contact-change/undo', { body: { username: textField(data, 'username'), code: textField(data, 'code') } }))
      .then(() => setDone(true))
      .catch((err: unknown) => {
        const failed = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
        if (failed.code === 'contact.undo_invalid') setRefused(true);
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
        <h1 className="auth__heading">Your address is back</h1>
        <p className="auth__sub">Every session on your account was signed out. Your old password no longer works, so set a new one before you sign in.</p>
        <Link className={buttonClass('action', true)} href="/reset-password">
          Set a new password
        </Link>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <h1 className="auth__heading">Undo an address change</h1>
        <p className="auth__sub">If your address was changed and it wasn’t you, use the code from the email we sent to your old address. It works for 72 hours.</p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        {refused ? <Notice>That didn’t work. Check your number and the code. A code stops working after 72 hours.</Notice> : null}
        <form method="post" className="auth__form" onSubmit={onSubmit} noValidate>
          <TextField label="Matric or staff number" name="username" autoComplete="username" autoCapitalize="characters" spellCheck={false} required />
          <TextField label="Undo code" name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
          <div className="auth__actions">
            <Button type="submit" block pending={pending}>
              {pending ? 'Undoing…' : 'Undo the change'}
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
