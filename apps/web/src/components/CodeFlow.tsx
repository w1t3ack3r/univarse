'use client';

import { passwordProblemMessage } from '@univarse/contracts';
import { ArrowLeft, ArrowRight, Button, Card, Check, Mail, Notice, Refresh, Steps, buttonClass } from '@univarse/ui';
import { CodeField, ExpiryBar, PasswordField, TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { api, ApiError } from '@/lib/client-api';

/**
 * Activation (W11) and password reset (W12): one fixed card, the stage changes (direction contract).
 * The request answer is identical whether or not the account exists (spec 0001 R1), so the copy never
 * says an account was found.
 */
type Kind = 'activation' | 'reset';

const COPY = {
  activation: {
    steps: ['Your account', 'Email code', 'Password', 'Done'],
    title0: 'Activate your account',
    sub0: 'Use the matric or staff number your institution gave you. We’ll email you a code to prove it’s you.',
    send: 'Email me a code',
    sent: 'If that account is waiting to be activated, we’ve emailed a 6-digit code to the address your institution has on file.',
    title2: 'Choose your password',
    sub2: 'You’ll use it with your matric or staff number every time you sign in.',
    submit: 'Activate my account',
    doneTitle: 'You’re all set',
    doneBody: 'Your account is active. Sign in with your matric or staff number and the password you just chose.',
    invalid: 'auth.activation_invalid',
  },
  reset: {
    steps: ['Your account', 'Email code', 'Password', 'Done'],
    title0: 'Reset your password',
    sub0: 'Enter your matric number, staff number or email. We’ll email you a code to choose a new password.',
    send: 'Email me a code',
    sent: 'If an active account matches, we’ve emailed a 6-digit code to its address.',
    title2: 'Choose a new password',
    sub2: 'Pick something you haven’t used here before.',
    submit: 'Save new password',
    doneTitle: 'Password changed',
    doneBody: 'For your safety we’ve signed you out on every device. Sign in again with your new password.',
    invalid: 'auth.reset_invalid',
  },
} as const;

const PATHS = {
  activation: { request: '/api/v1/auth/activation/request', confirm: '/api/v1/auth/activation/confirm' },
  reset: { request: '/api/v1/auth/password-reset/request', confirm: '/api/v1/auth/password-reset/confirm' },
} as const;

const RESEND_AFTER_S = 45;

export function CodeFlow({ kind, institution }: { kind: Kind; institution: string }) {
  const copy = COPY[kind];
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [issuedAt, setIssuedAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [codeError, setCodeError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [resendIn, setResendIn] = useState(0);
  const [expired, setExpired] = useState(false);
  const newCodeButton = useRef<HTMLButtonElement>(null);

  // When the code expires, move focus to the only action that can still succeed (no caret inviting typing).
  useEffect(() => {
    if (expired) newCodeButton.current?.focus();
  }, [expired]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function requestCode() {
    setPending(true);
    setError(null);
    try {
      await api('POST', PATHS[kind].request, { username });
      setIssuedAt(Date.now());
      setExpired(false);
      setResendIn(RESEND_AFTER_S);
      setCode('');
      setCodeError(undefined);
      setStage(1);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
    } finally {
      setPending(false);
    }
  }

  async function confirm(password: string) {
    setPending(true);
    setError(null);
    setPasswordError(undefined);
    try {
      await api('POST', PATHS[kind].confirm, { username, code, password });
      setStage(3);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
      if (e.code === 'auth.password_rejected') {
        setPasswordError(e.fieldErrors.map((f) => passwordProblemMessage(f.code)).join(' '));
      } else if (e.code === copy.invalid) {
        // The code (not the password) was the problem: go back to it.
        setCode('');
        setCodeError('That code didn’t work. It may have expired or been mistyped. Check your email, or ask for a new one.');
        setStage(1);
      } else {
        setError(e);
      }
    } finally {
      setPending(false);
    }
  }

  const onAccount = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (username.trim()) void requestCode();
  };
  const onCode = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.length === 6) setStage(2);
    else setCodeError('Enter all 6 digits from the email.');
  };
  const onPassword = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get('password');
    void confirm(typeof v === 'string' ? v : '');
  };

  return (
    <>
      <Card className="auth__card">
        <Steps steps={copy.steps} current={stage} />
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

        {stage === 0 ? (
          <>
            <h1 id="auth-heading" className="auth__heading">
              {copy.title0}
            </h1>
            <p className="auth__sub">{copy.sub0}</p>
            <form className="auth__form" onSubmit={onAccount} noValidate>
              <TextField
                label={kind === 'activation' ? 'Matric or staff number' : 'Matric number, staff number or email'}
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <div className="auth__actions">
                <Button type="submit" block pending={pending} disabled={!username.trim()}>
                  {copy.send}
                  {pending ? null : <ArrowRight />}
                </Button>
              </div>
            </form>
          </>
        ) : null}

        {stage === 1 ? (
          <>
            <span className="uv-icon-tile">
              <Mail />
            </span>
            <h1 id="auth-heading" className="auth__heading">
              Check your email
            </h1>
            <p className="auth__sub">{copy.sent}</p>
            <form className="auth__form" onSubmit={onCode} noValidate>
              <CodeField
                label="6-digit code"
                value={code}
                onChange={(v) => {
                  setCode(v);
                  setCodeError(undefined);
                }}
                error={codeError}
                autoFocus
              />
              <ExpiryBar
                issuedAt={issuedAt}
                minutes={15}
                onExpire={() => {
                  setExpired(true);
                  setResendIn(0); // the only way forward is a new code: never lock it
                }}
              />
              <div className="auth__actions">
                {expired ? (
                  <Button ref={newCodeButton} type="button" block pending={pending} onClick={() => void requestCode()}>
                    <Refresh size={18} />
                    Send me a new code
                  </Button>
                ) : (
                  <Button type="submit" block disabled={code.length !== 6}>
                    Continue
                    <ArrowRight />
                  </Button>
                )}
                <div className="row-actions">
                  <Button type="button" variant="plain" onClick={() => setStage(0)}>
                    <ArrowLeft size={18} />
                    Change account
                  </Button>
                  {expired ? null : (
                    <Button type="button" variant="plain" disabled={resendIn > 0 || pending} onClick={() => void requestCode()}>
                      <Refresh size={18} />
                      {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                    </Button>
                  )}
                </div>
              </div>
            </form>
          </>
        ) : null}

        {stage === 2 ? (
          <>
            <h1 id="auth-heading" className="auth__heading">
              {copy.title2}
            </h1>
            <p className="auth__sub">{copy.sub2}</p>
            <form className="auth__form" onSubmit={onPassword} noValidate>
              <PasswordField
                label={kind === 'activation' ? 'Password' : 'New password'}
                name="password"
                autoComplete="new-password"
                required
                autoFocus
                hint="At least 8 characters. A short sentence is easy to remember and hard to guess."
                error={passwordError}
              />
              <div className="auth__actions">
                <Button type="submit" block pending={pending}>
                  {pending ? 'Saving…' : copy.submit}
                </Button>
                <Button type="button" variant="plain" onClick={() => setStage(1)}>
                  <ArrowLeft size={18} />
                  Back to the code
                </Button>
              </div>
            </form>
          </>
        ) : null}

        {stage === 3 && kind === 'activation' ? (
          <div className="welcome" role="status">
            <span className="welcome__seal">
              <Check size={40} />
            </span>
            <h1 id="auth-heading" className="welcome__name">
              Welcome to {institution}
            </h1>
            <p className="auth__sub">Your account is active. Here’s what happens next:</p>
            <ol className="welcome__next">
              <li>
                <span className="welcome__step">1</span>
                <span>Sign in with your matric or staff number and the password you just chose.</span>
              </li>
              <li>
                <span className="welcome__step">2</span>
                <span>Turn on two-step sign-in from your workspace, so a stolen password isn’t enough to get in.</span>
              </li>
            </ol>
            <Link className={buttonClass('action', true)} href="/login">
              Sign in
              <ArrowRight />
            </Link>
          </div>
        ) : null}

        {stage === 3 && kind === 'reset' ? (
          <div className="done" role="status">
            <span className="done__mark">
              <Check size={32} />
            </span>
            <h1 id="auth-heading" className="auth__heading">
              {copy.doneTitle}
            </h1>
            <p className="auth__sub">{copy.doneBody}</p>
            <Link className={buttonClass('action', true)} href="/login">
              Sign in
              <ArrowRight />
            </Link>
          </div>
        ) : null}
      </Card>
      {stage < 3 ? (
        <div className="auth__more">
          <p>
            Remembered it?{' '}
            <Link className="uv-link" href="/login">
              Back to sign in
            </Link>
          </p>
        </div>
      ) : null}
    </>
  );
}
