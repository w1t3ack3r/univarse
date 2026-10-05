'use client';

import { Alert, Button, TextField } from '@univarse/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { api, ApiError } from '@/lib/client-api';
import { textField } from '@/lib/form';

interface LoginResponse {
  readonly mfaRequired?: true;
  readonly mfaEnrolmentRequired?: true;
}

/** Spec 0005 W4. Errors come from problem codes and always show the request id. */
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
      const res = await api<LoginResponse>('POST', '/api/v1/auth/login', {
        username: textField(form, 'username'),
        password: textField(form, 'password'),
      });
      router.replace(res.mfaRequired ? '/login/verify' : res.mfaEnrolmentRequired ? '/mfa/setup' : '/workspace');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      <h1 id="auth-heading" className="text-2xl font-semibold">
        Sign in
      </h1>
      {error ? <Alert requestId={error.requestId}>{error.message}</Alert> : null}
      <TextField label="Username or email" name="username" autoComplete="username" required autoCapitalize="none" spellCheck={false} />
      <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" block pending={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
