'use client';

import { Button, Card, Notice } from '@univarse/ui';
import { PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

/** Spec 0005 W4. Errors come from problem codes and always show the support reference. */
export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await unwrap(
        client.POST('/api/v1/auth/login', { body: { username: textField(form, 'username'), password: textField(form, 'password') } }),
      );
      // Two outcomes (generated union): an MFA challenge (challenge cookie set) or a session (session cookie set).
      router.replace('mfaRequired' in res ? '/login/verify' : res.mfaEnrolmentRequired ? '/mfa/setup' : '/workspace');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
      setPending(false);
    }
  }

  return (
    <>
      <Card className="auth__card">
        <h1 id="auth-heading" className="auth__heading">
          Welcome back
        </h1>
        <p className="auth__sub">Sign in with your matric number, staff number or email.</p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <form onSubmit={(e) => void onSubmit(e)} className="auth__form" noValidate>
          <TextField label="Matric number, staff number or email" name="username" autoComplete="username" required autoCapitalize="none" spellCheck={false} />
          <PasswordField label="Password" name="password" autoComplete="current-password" required />
          <div className="auth__actions">
            <Button type="submit" block pending={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
        </form>
      </Card>
      <div className="auth__more">
        <p>
          First time here?{' '}
          <Link className="uv-link" href="/activate">
            Activate your account
          </Link>
        </p>
        <p>
          <Link className="uv-link" href="/reset-password">
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}
