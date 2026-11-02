'use client';

import { Button, Download, Notice } from '@univarse/ui';
import { CopyButton } from '@univarse/ui/client';
import { useCallback, useEffect, useState } from 'react';
import { useStepUp } from '../../components/step-up';
import { api, ApiError, asApiError } from '../../lib/api';
import { describeDevice, when } from '../../lib/device';

interface Session {
  readonly id: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * Your account (spec 0028 Q8, Q11): where you're signed in (at most 3 places; end any but this one here), and new
 * recovery codes, which need a step-up and sign out your other sessions.
 */
export function AccountView() {
  const stepUp = useStepUp();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [making, setMaking] = useState(false);

  const load = useCallback(() => {
    api<{ data: Session[] }>('GET', '/me/sessions')
      .then((r) => setSessions(r.data))
      .catch((err: unknown) => setError(asApiError(err)));
  }, []);
  useEffect(load, [load]);

  const end = (id: string) => {
    setEnding(id);
    setError(null);
    api('DELETE', `/me/sessions/${id}`)
      .then(load)
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setEnding(null));
  };

  const makeCodes = () => {
    setMaking(true);
    setError(null);
    stepUp(() => api<{ recoveryCodes: string[] }>('POST', '/me/mfa/recovery-codes'))
      .then((r) => {
        if (r) {
          setCodes(r.recoveryCodes);
          load();
        }
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setMaking(false));
  };

  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          `UniVarse Console recovery codes\nEach code works once. Keep them offline.\n\n${codes.join('\n')}\n`,
        ],
        { type: 'text/plain' },
      ),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'univarse-console-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}

      <section className="pc-section" aria-labelledby="sessions-title">
        <h1 id="sessions-title" className="pc-section__title">
          Where you’re signed in
        </h1>
        <p className="pc-section__lead">
          At most 3 at once: a fourth sign-in ends the oldest. End any you don’t recognise, then
          change your password.
        </p>
        {sessions === null ? (
          <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
        ) : (
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Browser</th>
                <th scope="col">Signed in</th>
                <th scope="col">Last active</th>
                <th scope="col">Address</th>
                <th scope="col">
                  <span className="uv-visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="pc-table__strong">{describeDevice(s.userAgent)}</span>
                    {s.current ? (
                      <span className="pc-status pc-status--on">This browser</span>
                    ) : null}
                  </td>
                  <td data-label="Signed in">{when(s.createdAt)}</td>
                  <td data-label="Last active">{when(s.lastSeenAt)}</td>
                  <td className="pc-table__mono" data-label="Address">{s.ip ?? 'Unknown'}</td>
                  <td className="pc-table__action">
                    {s.current ? null : (
                      <Button
                        type="button"
                        variant="quiet"
                        pending={ending === s.id}
                        onClick={() => end(s.id)}
                        aria-label={`End the session on ${describeDevice(s.userAgent)}`}
                      >
                        End
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="pc-section" aria-labelledby="codes-title">
        <h2 id="codes-title" className="pc-section__title">
          Recovery codes
        </h2>
        <p className="pc-section__lead">
          Lost them, or used some? Make 10 new ones. Every earlier code stops working, and your
          other sessions are signed out. You’ll confirm with your authenticator first.
        </p>
        {codes ? (
          <>
            <Notice tone="success">Here are your new codes. They won’t be shown again.</Notice>
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
          </>
        ) : (
          <div className="pc-row-actions pc-row-actions--start">
            <Button type="button" variant="quiet" pending={making} onClick={makeCodes}>
              Make new recovery codes
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
