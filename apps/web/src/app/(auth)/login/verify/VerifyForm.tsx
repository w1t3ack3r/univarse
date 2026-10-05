'use client';

import { Button, Card, Notice, Smartphone, Key } from '@univarse/ui';
import { CodeField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { api, ApiError } from '@/lib/client-api';
import { textField } from '@/lib/form';

/** Spec 0005 W5: authenticator code (submits itself at six digits), or a recovery code. */
export function VerifyForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function verify(body: { code: string } | { recoveryCode: string }) {
    setPending(true);
    setError(null);
    try {
      await api('POST', '/api/v1/auth/mfa/verify', body);
      router.replace('/workspace');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
      setCode('');
      setPending(false);
    }
  }

  function onCodeChange(next: string) {
    setCode(next);
    if (next.length === 6 && !pending) void verify({ code: next });
  }

  function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === 'code') {
      if (code.length === 6) void verify({ code });
      return;
    }
    void verify({ recoveryCode: textField(new FormData(e.currentTarget), 'recovery').trim() });
  }

  return (
    <>
      <Card className="auth__card">
        <span className="uv-icon-tile">{mode === 'code' ? <Smartphone /> : <Key />}</span>
        <h1 id="auth-heading" className="auth__heading">
          {mode === 'code' ? 'Enter the code from your app' : 'Use a recovery code'}
        </h1>
        <p className="auth__sub">
          {mode === 'code'
            ? 'Open your authenticator app and type the 6-digit code it shows for UniVarse.'
            : 'Type one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'}
        </p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <form onSubmit={onSubmit} className="auth__form" noValidate>
          {mode === 'code' ? (
            <CodeField label="6-digit code" value={code} onChange={onCodeChange} autoFocus />
          ) : (
            <TextField
              key="recovery"
              label="Recovery code"
              hint="Looks like ABCDE-FGHJK. Capitals and the dash don’t matter."
              name="recovery"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          )}
          <div className="auth__actions">
            <Button type="submit" block pending={pending} disabled={mode === 'code' && code.length !== 6}>
              {pending ? 'Checking…' : 'Continue'}
            </Button>
            <Button
              type="button"
              variant="plain"
              onClick={() => {
                setMode(mode === 'code' ? 'recovery' : 'code');
                setError(null);
                setCode('');
              }}
            >
              {mode === 'code' ? 'Use a recovery code instead' : 'Use my authenticator app'}
            </Button>
          </div>
        </form>
      </Card>
      <div className="auth__more">
        <p>
          Wrong account?{' '}
          <Link className="uv-link" href="/login">
            Start again
          </Link>
        </p>
      </div>
    </>
  );
}
