'use client';

import {
  ArrowRight,
  Button,
  ChevronDown,
  Download,
  Notice,
  ShieldCheck,
  Steps,
} from '@univarse/ui';
import { CodeField, CopyButton } from '@univarse/ui/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthPanel } from '../../components/auth-panel';
import { PageSkeleton, type Me } from '../../components/console-shell';
import { api, ApiError, asApiError } from '../../lib/api';

/**
 * Spec 0028 Q7: the authenticator before anything else. Scan (or type the key), confirm with a first code, then the
 * 10 recovery codes, shown once, and an acknowledgement before the session can do anything. The QR is drawn in this
 * browser from the otpauth:// URI (the tenant app's way, MfaSetup.tsx): the secret never leaves the page.
 */
const STEPS = ['Scan', 'Code', 'Save codes'];

interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
}

export function SetupFlow() {
  const router = useRouter();
  const [state, setState] = useState<Me['state'] | null>(null);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  // Where this session stands: no session goes to sign in, a full one home; an enrolment-only one starts here.
  useEffect(() => {
    let live = true;
    api<Me>('GET', '/me')
      .then((me) => {
        if (!live) return;
        if (me.state === 'full') router.replace('/');
        else setState(me.state);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) router.replace('/sign-in');
        else setError(asApiError(err));
      });
    return () => {
      live = false;
    };
  }, [router]);

  // Start enrolment once, as soon as the session is known to need it.
  useEffect(() => {
    if (state !== 'enrol' || enrolment) return;
    let live = true;
    api<Enrolment>('POST', '/me/mfa/enrol')
      .then((e) => live && setEnrolment(e))
      .catch((err: unknown) => live && setError(asApiError(err)));
    return () => {
      live = false;
    };
  }, [state, enrolment]);

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

  const confirm = (value: string) => {
    setPending(true);
    setError(null);
    setFieldError(undefined);
    api<{ recoveryCodes: string[] }>('POST', '/me/mfa/enrol/confirm', { code: value })
      .then((res) => {
        setCodes(res.recoveryCodes);
        setStage(2);
      })
      .catch((err: unknown) => {
        const e = asApiError(err);
        if (e.code === 'auth.mfa_invalid')
          setFieldError('That code didn’t match. Wait for a fresh code in your app and try again.');
        else setError(e);
        setCode('');
      })
      .finally(() => setPending(false));
  };

  const acknowledge = () => {
    setPending(true);
    setError(null);
    api('POST', '/me/mfa/recovery-codes/saved')
      .then(() => router.replace('/'))
      .catch((err: unknown) => {
        setError(asApiError(err));
        setPending(false);
      });
  };

  const download = () => {
    const text = `UniVarse Console recovery codes\nEach code works once. Keep them offline, somewhere only you can reach.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'univarse-console-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!state && !error) return <PageSkeleton />;

  // A reload after the codes were shown: they can't be shown again (Q7). Saying so, and how to get new ones.
  if (state === 'recovery-codes' && codes.length === 0) {
    return (
      <AuthPanel>
        <span className="uv-icon-tile">
          <ShieldCheck />
        </span>
        <h1 className="pc-card__title">Your recovery codes were shown once</h1>
        <p className="pc-card__lead">
          Your authenticator is set up. If you didn’t save the recovery codes, continue, then make
          new ones under Your account: the old ones stop working.
        </p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <Button type="button" block pending={pending} onClick={acknowledge}>
          Continue
          {pending ? null : <ArrowRight />}
        </Button>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel>
      <Steps steps={STEPS} current={stage} />
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

      {stage === 0 ? (
        <>
          <h1 className="pc-card__title">Set up your authenticator app</h1>
          <p className="pc-card__lead">
            The console needs a code from your phone at every sign-in. In Google Authenticator,
            Microsoft Authenticator or any app that shows 6-digit codes, add an account and scan
            this.
          </p>
          <div className="pc-qr" role="img" aria-label="QR code for your authenticator app">
            {qr ? (
              <div dangerouslySetInnerHTML={{ __html: qr }} />
            ) : (
              <span className="pc-card__lead">Drawing the code…</span>
            )}
          </div>
          {enrolment ? (
            <details className="pc-disclosure">
              <summary className="uv-link">
                Can’t scan? Type this key instead
                <ChevronDown size={18} />
              </summary>
              <div className="pc-disclosure__body">
                <p className="pc-secret">
                  <span className="uv-visually-hidden">Setup key: </span>
                  {enrolment.secret.match(/.{1,4}/g)?.map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </p>
                <p className="pc-note">
                  Letters A–Z and digits 2–7 only, so there is no 0 or 1 to mix up.
                </p>
                <div className="pc-row-actions">
                  <CopyButton text={enrolment.secret} label="Copy key" />
                </div>
              </div>
            </details>
          ) : null}
          <div className="pc-actions">
            <Button type="button" block disabled={!enrolment} onClick={() => setStage(1)}>
              I’ve added it
              <ArrowRight />
            </Button>
          </div>
        </>
      ) : null}

      {stage === 1 ? (
        <>
          <h1 className="pc-card__title">Enter the code your app shows</h1>
          <p className="pc-card__lead">It changes every 30 seconds. Any current code works.</p>
          <form
            method="post"
            className="pc-form"
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
            <div className="pc-actions">
              <Button type="submit" block pending={pending} disabled={code.length !== 6}>
                Turn it on
              </Button>
              <Button type="button" variant="plain" onClick={() => setStage(0)}>
                Show the QR code again
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {stage === 2 ? (
        <>
          <h1 className="pc-card__title">Save your recovery codes</h1>
          <p className="pc-card__lead">
            If you lose your phone, each code signs you in once. This is the only time they’re
            shown. Keep them offline: printed, or in a password manager.
          </p>
          <ol className="pc-codes" aria-label="Recovery codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="pc-row-actions">
            <Button type="button" variant="quiet" onClick={download}>
              <Download size={18} />
              Download
            </Button>
            <CopyButton text={codes.join('\n')} label="Copy all" />
          </div>
          <label className="pc-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I’ve saved these codes somewhere safe.</span>
          </label>
          <div className="pc-actions">
            <Button type="button" block pending={pending} disabled={!saved} onClick={acknowledge}>
              Go to the console
              {pending ? null : <ArrowRight />}
            </Button>
          </div>
        </>
      ) : null}
    </AuthPanel>
  );
}
