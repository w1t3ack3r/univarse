'use client';

import { Button, Mail, Notice } from '@univarse/ui';
import { CodeField, PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { AuthPanel } from '../../components/auth-panel';
import { api, ApiError, asApiError, field, secretField } from '../../lib/api';
import { PASSWORD_HINT, passwordError } from '../../lib/password';

/**
 * Spec 0028 Q6: an invitation's emailed code, and a new password. Next comes the authenticator (Q7), before anything
 * else. The code lasts 15 minutes; an owner can send a new invitation.
 */
export function ActivateForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [codeError, setCodeError] = useState<string | undefined>();
  const [pwError, setPwError] = useState<string | undefined>();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setCodeError(undefined);
    setPwError(undefined);
    try {
      await api('POST', '/auth/activate', {
        email: field(form, 'email'),
        code,
        password: secretField(form, 'password'),
      });
      router.replace('/setup');
    } catch (err) {
      const e2 = asApiError(err);
      const pw = passwordError(e2);
      if (pw) setPwError(pw);
      else if (e2.code === 'auth.activation_invalid')
        setCodeError(
          'That code isn’t right, or it has expired. Ask an owner to send a new invitation.',
        );
      else setError(e2);
      setPending(false);
    }
  }

  return (
    <AuthPanel
      below={
        <p>
          Already activated?{' '}
          <Link className="uv-link" href="/sign-in">
            Sign in
          </Link>
        </p>
      }
    >
      <span className="uv-icon-tile">
        <Mail />
      </span>
      <h1 className="pc-card__title">Activate your account</h1>
      <p className="pc-card__lead">
        Enter the 6-digit code from your invitation email, and choose your password.
      </p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
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
        <CodeField
          label="Code from your invitation"
          value={code}
          onChange={(v) => {
            setCode(v);
            setCodeError(undefined);
          }}
          error={codeError}
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
            {pending ? 'Activating…' : 'Activate'}
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
