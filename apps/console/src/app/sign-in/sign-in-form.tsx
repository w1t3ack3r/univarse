'use client';

import { Button, Notice } from '@univarse/ui';
import { PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../components/auth-panel';
import { api, ApiError, asApiError, field, secretField } from '../../lib/api';

/** Spec 0028 Q7, Q8: a password, then the second factor (or, with no factor yet, its setup). */
export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await api<{ next: 'mfa' | 'enrol' }>('POST', '/auth/login', {
        email: field(form, 'email'),
        password: secretField(form, 'password'),
      });
      router.replace(res.next === 'mfa' ? '/sign-in/verify' : '/setup');
    } catch (err) {
      setError(asApiError(err));
      setPending(false);
    }
  }

  return (
    <AuthPanel
      below={
        <>
          <p>
            Invited to the console?{' '}
            <Link className="uv-link" href="/activate">
              Activate your account
            </Link>
          </p>
          <p>
            <Link className="uv-link" href="/reset-password">
              Forgot your password?
            </Link>
          </p>
        </>
      }
    >
      <h1 className="pc-card__title">Sign in to the console</h1>
      <p className="pc-card__lead">
        Use the email address your invitation came to. You’ll confirm with your authenticator app
        next.
      </p>
      {error ? (
        <Notice requestId={error.code === 'auth.invalid_credentials' ? undefined : error.requestId}>
          {error.code === 'auth.invalid_credentials'
            ? 'That email or password isn’t right.'
            : error.message}
        </Notice>
      ) : null}
      <form method="post" onSubmit={(e) => void onSubmit(e)} className="pc-form" noValidate>
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
        <PasswordField label="Password" name="password" autoComplete="current-password" required />
        <div className="pc-actions">
          <Button type="submit" block pending={pending}>
            {pending ? 'Signing in…' : 'Continue'}
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
