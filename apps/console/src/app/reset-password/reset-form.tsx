'use client';

import { Button, buttonClass, Check, Key, Notice } from '@univarse/ui';
import { CodeField, PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../components/auth-panel';
import { api, ApiError, asApiError, field, secretField } from '../../lib/api';
import { PASSWORD_HINT, passwordError } from '../../lib/password';

/**
 * Spec 0028 Q-A7: a code by email, then a new password. Every session ends, and signing in still needs the
 * authenticator. The first step answers the same whether or not the email belongs to anyone.
 */
export function ResetForm() {
  const [stage, setStage] = useState<'request' | 'confirm' | 'done'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [codeError, setCodeError] = useState<string | undefined>();
  const [pwError, setPwError] = useState<string | undefined>();

  const run = async (fn: () => Promise<unknown>, next: () => void) => {
    setPending(true);
    setError(null);
    setCodeError(undefined);
    setPwError(undefined);
    try {
      await fn();
      next();
    } catch (err) {
      const e = asApiError(err);
      const pw = passwordError(e);
      if (pw) setPwError(pw);
      else if (e.code === 'auth.reset_invalid')
        setCodeError('That code isn’t right, or it has expired. Ask for a new one.');
      else setError(e);
    } finally {
      setPending(false);
    }
  };

  const onRequest = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = field(new FormData(e.currentTarget), 'email');
    void run(
      () => api('POST', '/auth/password-reset/request', { email: value }),
      () => {
        setEmail(value);
        setStage('confirm');
      },
    );
  };

  const onConfirm = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = secretField(new FormData(e.currentTarget), 'password');
    void run(
      () => api('POST', '/auth/password-reset/confirm', { email, code, password }),
      () => setStage('done'),
    );
  };

  const back = (
    <p>
      <Link className="uv-link" href="/sign-in">
        Back to sign in
      </Link>
    </p>
  );

  if (stage === 'done') {
    return (
      <AuthPanel>
        <span className="uv-icon-tile">
          <Check />
        </span>
        <h1 className="pc-card__title">Your password is changed</h1>
        <p className="pc-card__lead">
          Every session on your account was signed out. Sign in with your new password and your
          authenticator app.
        </p>
        <Link className={buttonClass('action', true)} href="/sign-in">
          Sign in
        </Link>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel below={back}>
      <span className="uv-icon-tile">
        <Key />
      </span>
      {stage === 'request' ? (
        <>
          <h1 className="pc-card__title">Reset your password</h1>
          <p className="pc-card__lead">
            We’ll email a 6-digit code to your account’s address. It lasts 15 minutes.
          </p>
          {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
          <form method="post" className="pc-form" onSubmit={onRequest} noValidate>
            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <div className="pc-actions">
              <Button type="submit" block pending={pending}>
                {pending ? 'Sending…' : 'Send the code'}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <h1 className="pc-card__title">Choose a new password</h1>
          <p className="pc-card__lead">
            If {email} belongs to a console account, a code is on its way. Enter it with your new
            password.
          </p>
          {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
          <form method="post" className="pc-form" onSubmit={onConfirm} noValidate>
            <CodeField
              label="Code from the email"
              value={code}
              onChange={(v) => {
                setCode(v);
                setCodeError(undefined);
              }}
              error={codeError}
              autoFocus
            />
            <PasswordField
              label="New password"
              name="password"
              autoComplete="new-password"
              hint={PASSWORD_HINT}
              required
              error={pwError}
            />
            <div className="pc-actions">
              <Button type="submit" block pending={pending} disabled={code.length !== 6}>
                {pending ? 'Saving…' : 'Change my password'}
              </Button>
              <Button
                type="button"
                variant="plain"
                onClick={() => {
                  setStage('request');
                  setCode('');
                }}
              >
                Send a new code
              </Button>
            </div>
          </form>
        </>
      )}
    </AuthPanel>
  );
}
