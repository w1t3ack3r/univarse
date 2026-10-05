'use client';

import { Alert, Button, TextField } from '@univarse/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { api, ApiError } from '@/lib/client-api';
import { textField } from '@/lib/form';

/** Spec 0005 W5: authenticator code, or a recovery code. Wrong codes get one generic message. */
export function VerifyForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = textField(new FormData(e.currentTarget), 'value').trim();
    setPending(true);
    setError(null);
    try {
      await api('POST', '/api/v1/auth/mfa/verify', mode === 'code' ? { code: value } : { recoveryCode: value });
      router.replace('/workspace');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      <h1 id="auth-heading" className="text-2xl font-semibold">
        Confirm it&apos;s you
      </h1>
      {error ? <Alert requestId={error.requestId}>{error.message}</Alert> : null}
      {mode === 'code' ? (
        <TextField
          key="code"
          label="Authenticator code"
          hint="The 6-digit code from your authenticator app."
          name="value"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      ) : (
        <TextField
          key="recovery"
          label="Recovery code"
          hint="One of the recovery codes you saved when you set up MFA. Each works once."
          name="value"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
      )}
      <Button type="submit" block pending={pending}>
        {pending ? 'Checking…' : 'Continue'}
      </Button>
      <button
        type="button"
        className="justify-self-start text-sm underline"
        onClick={() => {
          setMode(mode === 'code' ? 'recovery' : 'code');
          setError(null);
        }}
      >
        {mode === 'code' ? 'Use a recovery code instead' : 'Use my authenticator app'}
      </button>
      <Link href="/login" className="text-sm">
        Start again
      </Link>
    </form>
  );
}
