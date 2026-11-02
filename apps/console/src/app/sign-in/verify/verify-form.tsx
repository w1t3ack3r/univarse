'use client';

import { Button, Notice, Smartphone } from '@univarse/ui';
import { CodeField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../../components/auth-panel';
import { api, ApiError, asApiError, field } from '../../../lib/api';

/**
 * Spec 0028 Q7: the second factor. A code from the authenticator app (it submits itself at the sixth digit) or a
 * recovery code. The challenge lasts 5 minutes and 5 tries; after that, signing in starts again.
 */
export function VerifyForm() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<ApiError | null>(null);

  const submit = (body: { code: string } | { recoveryCode: string }) => {
    setPending(true);
    setError(null);
    setFieldError(undefined);
    api('POST', '/auth/mfa', body)
      .then(() => router.replace('/'))
      .catch((err: unknown) => {
        const e = asApiError(err);
        if (e.code === 'auth.mfa_invalid') {
          setFieldError(
            recovery
              ? 'That recovery code isn’t right, or it was already used. If this keeps happening, sign in again.'
              : 'That code didn’t match. Wait for a fresh code in your app and try again. If this keeps happening, sign in again.',
          );
          setCode('');
        } else setError(e);
        setPending(false);
      });
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (recovery) submit({ recoveryCode: field(new FormData(e.currentTarget), 'recoveryCode') });
    else if (code.length === 6) submit({ code });
  };

  return (
    <AuthPanel
      below={
        <p>
          <Link className="uv-link" href="/sign-in">
            Start signing in again
          </Link>
        </p>
      }
    >
      <span className="uv-icon-tile">
        <Smartphone />
      </span>
      <h1 className="pc-card__title">
        {recovery ? 'Use a recovery code' : 'Enter your authenticator code'}
      </h1>
      <p className="pc-card__lead">
        {recovery
          ? 'Each of your 10 recovery codes works once. We’ll email you that one was used.'
          : 'Open your authenticator app and enter the 6-digit code for UniVarse Console.'}
      </p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <form method="post" className="pc-form" onSubmit={onSubmit} noValidate>
        {recovery ? (
          <TextField
            label="Recovery code"
            name="recoveryCode"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCDE-FGHJK"
            required
            error={fieldError}
          />
        ) : (
          <CodeField
            label="6-digit code"
            value={code}
            onChange={(v) => {
              setCode(v);
              setFieldError(undefined);
              if (v.length === 6 && !pending) submit({ code: v });
            }}
            error={fieldError}
            autoFocus
          />
        )}
        <div className="pc-actions">
          <Button type="submit" block pending={pending} disabled={!recovery && code.length !== 6}>
            {pending ? 'Checking…' : 'Sign in'}
          </Button>
          <Button
            type="button"
            variant="plain"
            onClick={() => {
              setRecovery((r) => !r);
              setFieldError(undefined);
              setError(null);
            }}
          >
            {recovery
              ? 'Use my authenticator app instead'
              : 'I don’t have my phone: use a recovery code'}
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
