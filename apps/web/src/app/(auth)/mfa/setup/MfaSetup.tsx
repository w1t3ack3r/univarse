'use client';

import { ArrowRight, Button, Card, ChevronDown, Download, Notice, ShieldCheck, Steps } from '@univarse/ui';
import { CodeField, CopyButton, PasswordField } from '@univarse/ui/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

/**
 * Two-step setup (W13): password → scan → first code → save recovery codes (shown once).
 * The QR is drawn in the browser from the otpauth:// URI; the secret never leaves this page.
 */
const STEPS = ['Password', 'Scan', 'Code', 'Save codes'];

interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
}

/** `leaveLater` (sign out and finish later) shows on the first step only: never once codes are on screen. */
export function MfaSetup({ required, leaveLater }: { required: boolean; leaveLater?: ReactNode }) {
  const router = useRouter();
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  useEffect(() => {
    if (!enrolment) return;
    let live = true;
    void import('qrcode').then((QR) =>
      QR.toString(enrolment.otpauthUri, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
        color: { dark: '#485550', light: '#ffffff' },
      }).then((svg) => {
        if (live) setQr(svg);
      }),
    );
    return () => {
      live = false;
    };
  }, [enrolment]);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError(null);
    setFieldError(undefined);
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
      if (e.code === 'auth.invalid_credentials') setFieldError('That password isn’t right.');
      else if (e.code === 'auth.mfa_invalid') setFieldError('That code didn’t match. Wait for a fresh code in your app and try again.');
      else setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  }

  const onPassword = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = textField(new FormData(e.currentTarget), 'password');
    void run(() => unwrap(client.POST('/api/v1/auth/mfa/totp/enrol', { body: { password } }))).then((res) => {
      if (res) {
        setEnrolment(res);
        setStage(1);
      }
    });
  };

  const confirm = (value: string) => {
    void run(() => unwrap(client.POST('/api/v1/auth/mfa/totp/confirm', { body: { code: value } }))).then((res) => {
      if (res) {
        setCodes(res.recoveryCodes);
        setStage(3);
      } else setCode('');
    });
  };

  const download = () => {
    const text = `UniVarse recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'univarse-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Card className="auth__card">
      <Steps steps={STEPS} current={stage} />
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

      {stage === 0 ? (
        <>
          <span className="uv-icon-tile">
            <ShieldCheck />
          </span>
          <h1 id="auth-heading" className="auth__heading">
            Turn on two-step sign-in
          </h1>
          <p className="auth__sub">
            {required
              ? 'Your role can approve or change important records, so your account needs a second step: a code from an app on your phone.'
              : 'Add a second step to signing in: a code from an app on your phone. Even if someone learns your password, they can’t get in.'}
          </p>
          <form className="auth__form" onSubmit={onPassword} noValidate>
            <PasswordField label="Confirm your password" name="password" autoComplete="current-password" required error={fieldError} />
            <div className="auth__actions">
              <Button type="submit" block pending={pending}>
                Continue
                {pending ? null : <ArrowRight />}
              </Button>
            </div>
          </form>
          {leaveLater}
        </>
      ) : null}

      {stage === 1 && enrolment ? (
        <>
          <h1 id="auth-heading" className="auth__heading">
            Scan this with your authenticator app
          </h1>
          <p className="auth__sub">
            Use Google Authenticator, Microsoft Authenticator or any app that shows 6-digit codes. Tap “add account”, then scan.
          </p>
          <div className="qr" role="img" aria-label="QR code for your authenticator app">
            {qr ? <div dangerouslySetInnerHTML={{ __html: qr }} /> : <span className="auth__sub">Drawing the code…</span>}
          </div>
          <details className="disclosure">
            <summary className="uv-link">
              Can’t scan? Type this key instead
              <ChevronDown size={18} />
            </summary>
            <div className="disclosure__body">
              <p className="secret" aria-label="Setup key">
                {enrolment.secret.match(/.{1,4}/g)?.map((g, i) => <span key={i}>{g}</span>)}
              </p>
              <p className="codes-note">Letters A–Z and digits 2–7 only, so there is no 0 or 1 to mix up.</p>
              <div className="row-actions">
                <CopyButton text={enrolment.secret} label="Copy key" />
              </div>
            </div>
          </details>
          <div className="auth__actions">
            <Button type="button" block onClick={() => setStage(2)}>
              I’ve added it
              <ArrowRight />
            </Button>
          </div>
        </>
      ) : null}

      {stage === 2 ? (
        <>
          <h1 id="auth-heading" className="auth__heading">
            Enter the code your app shows
          </h1>
          <p className="auth__sub">It changes every 30 seconds. Any current code works.</p>
          <form
            className="auth__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6) confirm(code);
            }}
            noValidate
          >
            <CodeField
              label="6-digit code"
              value={code}
              onChange={(v) => {
                setCode(v);
                setFieldError(undefined);
                if (v.length === 6 && !pending) confirm(v);
              }}
              error={fieldError}
              autoFocus
            />
            <div className="auth__actions">
              <Button type="submit" block pending={pending} disabled={code.length !== 6}>
                Turn it on
              </Button>
              <Button type="button" variant="plain" onClick={() => setStage(1)}>
                Show the QR code again
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {stage === 3 ? (
        <>
          <h1 id="auth-heading" className="auth__heading">
            Save your recovery codes
          </h1>
          <p className="auth__sub">
            If you lose your phone, each of these lets you sign in once. This is the only time we’ll show them, so save them now.
          </p>
          <ul className="codes" aria-label="Recovery codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="codes-note">Letters A–Z and digits 2–7 only, so there is no 0 or 1 to mix up.</p>
          <div className="row-actions">
            <CopyButton text={codes.join('\n')} label="Copy all" />
            <Button type="button" variant="quiet" onClick={download}>
              <Download />
              Download
            </Button>
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I’ve saved these codes somewhere safe (not only on this phone).</span>
          </label>
          <Button
            type="button"
            block
            disabled={!saved}
            onClick={() => {
              router.replace('/workspace');
              router.refresh();
            }}
          >
            Go to my workspace
            <ArrowRight />
          </Button>
        </>
      ) : null}
    </Card>
  );
}
