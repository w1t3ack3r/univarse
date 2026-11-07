'use client';

import { Button, ChevronDown, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { textField } from '@/lib/form';

/**
 * Spec 0032 Q7, Q8, Q9. Not activated yet, the address changes at once. Otherwise the person finishes it, with a code
 * and their password, so no administrator can take an account over alone. Only here can the old address be marked wrong.
 */
export function CorrectAddress({ userId, name, activated }: { userId: string; name: string; activated: boolean }) {
  const withStepUp = useStepUp();
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = textField(new FormData(form), 'email').trim().toLowerCase();
    setBusy(true);
    setError(null);
    setDone(false);
    withStepUp(() => unwrap(client.POST('/api/v1/users/{id}/email', { params: { path: { id: userId } }, body: { email, oldAddressWrong: activated && wrong } })))
      .then((r) => {
        if (r === undefined) return;
        setDone(true);
        form.reset();
        setWrong(false);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined)))
      .finally(() => setBusy(false));
  };

  return (
    <details className="row-disclosure">
      <summary className="uv-link">
        Correct address
        <ChevronDown size={18} />
      </summary>
      <form method="post" className="auth__form" onSubmit={onSubmit} noValidate>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        {done ? <Notice tone="success">{activated ? `A code went to the new address. ${name} finishes the change with it and their password.` : `${name}’s address is corrected, and an activation code went to it.`}</Notice> : null}
        <TextField label={`${name}’s correct email`} name="email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
        {activated ? (
          <label className="check">
            <input type="checkbox" checked={wrong} onChange={(e) => setWrong(e.target.checked)} />
            <span>The old address is wrong. Send nothing to it, because it may be a stranger’s.</span>
          </label>
        ) : null}
        <Button type="submit" variant="quiet" pending={busy}>
          Correct the address
        </Button>
      </form>
    </details>
  );
}
