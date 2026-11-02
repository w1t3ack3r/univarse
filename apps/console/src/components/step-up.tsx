'use client';

import { Button, Notice, ShieldCheck } from '@univarse/ui';
import { CodeField, TextField } from '@univarse/ui/client';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { api, ApiError, asApiError, field } from '../lib/api';

/**
 * Step-up (spec 0028 Q11): when the platform API answers 428, a dialog asks for a code from the authenticator app
 * (or a recovery code), then the action is retried once. The tenant web app's pattern (StepUp.tsx), without the
 * password: the console's step-up is the second factor alone. A native <dialog>: the browser traps focus, handles
 * Escape and makes the page behind it inert.
 */
type Ask = () => Promise<boolean>;
const StepUpContext = createContext<Ask | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const ask = useCallback<Ask>(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setCode('');
        setRecovery(false);
        setError(null);
        setFieldError(undefined);
        dialog.current?.showModal();
      }),
    [],
  );

  const close = (ok: boolean) => {
    dialog.current?.close();
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = (body: { code: string } | { recoveryCode: string }) => {
    setPending(true);
    setError(null);
    setFieldError(undefined);
    api('POST', '/me/step-up', body)
      .then(() => close(true))
      .catch((err: unknown) => {
        const e = asApiError(err);
        if (e.code === 'auth.mfa_invalid') {
          setFieldError(
            recovery
              ? 'That recovery code isn’t right, or it was already used.'
              : 'That code didn’t match. Wait for a fresh code in your app and try again.',
          );
          setCode('');
        } else setError(e);
      })
      .finally(() => setPending(false));
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (recovery) submit({ recoveryCode: field(new FormData(e.currentTarget), 'recoveryCode') });
    else if (code.length === 6) submit({ code });
  };

  return (
    <StepUpContext.Provider value={ask}>
      {children}
      <dialog
        ref={dialog}
        className="pc-dialog"
        aria-labelledby="stepup-title"
        onCancel={() => close(false)}
      >
        <form method="post" className="pc-dialog__body" onSubmit={onSubmit} noValidate>
          <span className="uv-icon-tile">
            <ShieldCheck />
          </span>
          <h2 id="stepup-title" className="pc-card__title">
            Confirm it’s you
          </h2>
          <p className="pc-card__lead">
            This changes who can reach the platform. Once you confirm, you won’t be asked again for
            5 minutes.
          </p>
          {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
          {recovery ? (
            <TextField
              label="Recovery code"
              name="recoveryCode"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              error={fieldError}
            />
          ) : (
            <CodeField
              label="Code from your authenticator app"
              value={code}
              onChange={(v) => {
                setCode(v);
                setFieldError(undefined);
                if (v.length === 6 && !pending) submit({ code: v });
              }}
              error={fieldError}
            />
          )}
          <div className="pc-actions">
            <Button type="submit" block pending={pending} disabled={!recovery && code.length !== 6}>
              Confirm
            </Button>
            <Button
              type="button"
              variant="plain"
              onClick={() => {
                setRecovery((r) => !r);
                setFieldError(undefined);
              }}
            >
              {recovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
            </Button>
            <Button type="button" variant="quiet" block onClick={() => close(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </dialog>
    </StepUpContext.Provider>
  );
}

/** Runs `action`; on 428 asks for a step-up and retries it once. Other errors propagate. Undefined if cancelled. */
export function useStepUp() {
  const ask = useContext(StepUpContext);
  return useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'auth.step_up_required' || !ask) throw err;
        if (!(await ask())) return undefined;
        return action();
      }
    },
    [ask],
  );
}
