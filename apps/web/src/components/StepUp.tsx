'use client';

import { Button, Notice, ShieldCheck } from '@univarse/ui';
import { CodeField, PasswordField } from '@univarse/ui/client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { api, ApiError } from '@/lib/client-api';
import { textField } from '@/lib/form';

/**
 * Step-up (spec 0005 W14, spec 0001 S1–S12). When the API answers 428 auth.step_up_required, a
 * dialog asks the person to confirm who they are, then the original action is retried once.
 * Native <dialog>: the browser handles focus trapping, Escape and the inert background.
 */
type Ask = () => Promise<boolean>;
const StepUpContext = createContext<Ask | null>(null);

export function StepUpProvider({ hasMfa, children }: { hasMfa: boolean; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const ask = useCallback<Ask>(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setCode('');
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

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = textField(new FormData(e.currentTarget), 'password');
    setPending(true);
    setError(null);
    setFieldError(undefined);
    api('POST', '/api/v1/auth/step-up', hasMfa ? { password, code } : { password })
      .then(() => close(true))
      .catch((err: unknown) => {
        const e2 = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
        if (e2.code === 'auth.invalid_credentials' || e2.code === 'auth.mfa_invalid') {
          setFieldError('That didn’t match. Check your password and the code in your app.');
          setCode('');
        } else setError(e2);
      })
      .finally(() => setPending(false));
  };

  return (
    <StepUpContext.Provider value={ask}>
      {children}
      <dialog ref={dialog} className="dialog" aria-labelledby="stepup-title" onCancel={() => close(false)}>
        <form className="dialog__body" onSubmit={onSubmit} noValidate>
          <span className="uv-icon-tile">
            <ShieldCheck />
          </span>
          <h2 id="stepup-title" className="auth__heading">
            Confirm it’s you
          </h2>
          <p className="auth__sub">This is a sensitive action. Once you confirm, you won’t be asked again for 5 minutes.</p>
          {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
          <PasswordField label="Your password" name="password" autoComplete="current-password" required error={hasMfa ? undefined : fieldError} />
          {hasMfa ? <CodeField label="Code from your authenticator app" value={code} onChange={setCode} error={fieldError} /> : null}
          <div className="auth__actions">
            <Button type="submit" block pending={pending} disabled={hasMfa && code.length !== 6}>
              Confirm
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

/** Runs `action`; on 428 asks for step-up and retries it once (W14). Other errors propagate. */
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
