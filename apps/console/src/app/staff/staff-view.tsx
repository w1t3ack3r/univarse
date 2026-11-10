'use client';

import { Button, ChevronDown, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import { ROLE_LABEL, useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { useStepUp } from '../../components/step-up';
import { api, ApiError, asApiError, field } from '../../lib/api';
import { when } from '../../lib/device';

interface Member {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaEnrolled: boolean;
  readonly lastLoginAt: string | null;
}

const ROLES = ['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'READ_ONLY'] as const;

/** What each role can do today, said where the role is chosen. */
const ROLE_HINT: Readonly<Record<string, string>> = {
  OWNER: 'Everything, including who can reach the console.',
  SUPER_ADMIN: 'Runs the platform: manages institutions; sees the staff list, the audit log and security.',
  SUPPORT: 'Helps institutions: looks them up, changes nothing.',
  FINANCE: 'Plans and billing, as they arrive: looks institutions up, changes nothing.',
  READ_ONLY: 'Sees institutions, the staff list, the audit log and security; changes nothing.',
};

/**
 * Staff (spec 0028 Q13, Q14): who can reach the console. Everyone with platform.staff.read sees the list; only an
 * OWNER changes it, and every change asks for a step-up first (the dialog). The API refuses one's own account and the
 * last OWNER; this page doesn't offer them.
 */
export function StaffView() {
  const me = useMe();
  const stepUp = useStepUp();
  const canRead = me.permissions.includes('platform.staff.read');
  const canManage = me.permissions.includes('platform.staff.manage');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!canRead) return;
    api<{ data: Member[] }>('GET', '/staff')
      .then((r) => setMembers(r.data))
      .catch((err: unknown) => setError(asApiError(err)));
  }, [canRead]);
  useEffect(load, [load]);

  /** A staff change: step-up when asked, then the list again. Returns whether it happened. */
  const change = async (
    key: string,
    action: () => Promise<unknown>,
    message: string,
  ): Promise<boolean> => {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const r = await stepUp(action);
      if (r === undefined) return false;
      setDone(message);
      load();
      return true;
    } catch (err) {
      setError(asApiError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Out of scope reads as absent (docs/08): the same page as an unknown address.
  if (!canRead) return <NothingHere />;

  return (
    <>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}

      <section className="pc-section" aria-labelledby="staff-title">
        <div className="pc-section__head">
          <div>
            <h1 id="staff-title" className="pc-section__title">
              Staff
            </h1>
            <p className="pc-section__lead">
              Everyone who can reach the console. Each change is recorded and emailed to the person
              it affects.
            </p>
          </div>
        </div>

        {canManage ? (
          <Invite
            busy={busy === 'invite'}
            onInvite={(input) =>
              change(
                'invite',
                () => api('POST', '/staff', input),
                `Invitation sent to ${input.email}. Their activation code lasts 15 minutes.`,
              )
            }
          />
        ) : null}

        {members === null ? (
          error ? null : (
            <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
          )
        ) : (
          <ul className="pc-members">
            {members.map((m) => (
              <li key={m.id} className="pc-member" data-inactive={m.isActive ? undefined : 'true'}>
                <div className="pc-member__main">
                  <p className="pc-member__name">
                    {m.displayName}
                    {m.id === me.id ? <span className="pc-member__you"> (you)</span> : null}
                  </p>
                  <p className="pc-member__email">{m.email}</p>
                </div>
                <div className="pc-member__facts">
                  <span className="pc-role">{ROLE_LABEL[m.role] ?? m.role}</span>
                  {!m.isActive ? (
                    <span className="pc-status pc-status--off">No access</span>
                  ) : m.mfaEnrolled ? (
                    <span className="pc-status pc-status--on">Authenticator on</span>
                  ) : (
                    <span className="pc-status pc-status--wait">Not activated yet</span>
                  )}
                  <span className="pc-member__seen">Last signed in: {when(m.lastLoginAt)}</span>
                </div>
                {canManage && m.id !== me.id ? (
                  <details className="pc-disclosure pc-member__manage">
                    <summary className="uv-link">
                      Manage
                      <ChevronDown size={18} />
                    </summary>
                    <div className="pc-disclosure__body">
                      {m.isActive ? (
                        <>
                          <RoleChange
                            member={m}
                            busy={busy === `role:${m.id}`}
                            onChange={(role) =>
                              change(
                                `role:${m.id}`,
                                () => api('POST', `/staff/${m.id}/role`, { role }),
                                `${m.displayName} is now ${ROLE_LABEL[role] ?? role}.`,
                              )
                            }
                          />
                          <CorrectAddress
                            member={m}
                            busy={busy === `email:${m.id}`}
                            onCorrect={(input) =>
                              change(
                                `email:${m.id}`,
                                () => api('POST', `/staff/${m.id}/email`, input),
                                m.emailVerified
                                  ? `A code went to the new address. ${m.displayName} finishes the change with it and their password.`
                                  : `${m.displayName}’s address is corrected, and a new activation code went to it.`,
                              )
                            }
                          />
                          <div className="pc-row-actions pc-row-actions--start">
                            {m.mfaEnrolled ? (
                              <Button
                                type="button"
                                variant="quiet"
                                pending={busy === `mfa:${m.id}`}
                                onClick={() =>
                                  void change(
                                    `mfa:${m.id}`,
                                    () => api('POST', `/staff/${m.id}/mfa-reset`),
                                    `${m.displayName}’s authenticator was removed. They’ll set up a new one at their next sign-in.`,
                                  )
                                }
                              >
                                Reset their authenticator
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="quiet"
                              className="pc-danger"
                              pending={busy === `off:${m.id}`}
                              onClick={() =>
                                void change(
                                  `off:${m.id}`,
                                  () => api('POST', `/staff/${m.id}/deactivate`),
                                  `${m.displayName} can no longer reach the console. Their sessions ended.`,
                                )
                              }
                            >
                              Remove access
                            </Button>
                          </div>
                        </>
                      ) : (
                        <div className="pc-row-actions pc-row-actions--start">
                          <Button
                            type="button"
                            variant="quiet"
                            pending={busy === `on:${m.id}`}
                            onClick={() =>
                              void change(
                                `on:${m.id}`,
                                () => api('POST', `/staff/${m.id}/reinstate`),
                                `${m.displayName} was invited back. Their activation code lasts 15 minutes.`,
                              )
                            }
                          >
                            Restore access
                          </Button>
                        </div>
                      )}
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function RoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="uv-field">
      <label className="uv-field__label" htmlFor={id}>
        Role
      </label>
      <span className="uv-field__hint" id={`${id}-hint`}>
        {ROLE_HINT[value]}
      </span>
      <div className="uv-field__control">
        <select
          id={id}
          name="role"
          className="uv-field__input pc-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function RoleChange({
  member,
  busy,
  onChange,
}: {
  member: Member;
  busy: boolean;
  onChange: (role: string) => Promise<boolean>;
}) {
  const [role, setRole] = useState(member.role);
  return (
    <form
      method="post"
      className="pc-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onChange(role);
      }}
    >
      <RoleSelect id={`role-${member.id}`} value={role} onChange={setRole} />
      <Button type="submit" variant="quiet" pending={busy} disabled={role === member.role}>
        Change role
      </Button>
    </form>
  );
}

/**
 * Spec 0032 Q7, Q8, Q9. Not activated yet, the address changes at once. Activated, the person finishes it, so no
 * administrator can take an account over alone. Only here can the old address be marked wrong: nothing then goes to it.
 */
function CorrectAddress({
  member,
  busy,
  onCorrect,
}: {
  member: Member;
  busy: boolean;
  onCorrect: (input: { email: string; oldAddressWrong: boolean }) => Promise<boolean>;
}) {
  const [wrong, setWrong] = useState(false);
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    void onCorrect({ email: field(new FormData(form), 'email'), oldAddressWrong: wrong }).then((ok) => {
      if (ok) {
        form.reset();
        setWrong(false);
      }
    });
  };
  return (
    <form method="post" className="pc-form" onSubmit={onSubmit} noValidate>
      <TextField label={`Correct ${member.displayName}’s email`} name="email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
      {member.emailVerified ? (
        <label className="pc-check">
          <input type="checkbox" checked={wrong} onChange={(e) => setWrong(e.target.checked)} />
          <span>The old address is wrong. Send nothing to it, because it may be a stranger’s.</span>
        </label>
      ) : null}
      <div className="pc-row-actions pc-row-actions--start">
        <Button type="submit" variant="quiet" pending={busy}>
          Correct the address
        </Button>
      </div>
    </form>
  );
}

function Invite({
  busy,
  onInvite,
}: {
  busy: boolean;
  onInvite: (input: { email: string; displayName: string; role: string }) => Promise<boolean>;
}) {
  const [role, setRole] = useState('SUPPORT');
  const [open, setOpen] = useState(false);
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void onInvite({
      email: field(data, 'email'),
      displayName: field(data, 'displayName'),
      role,
    }).then((ok) => {
      if (ok) {
        form.reset();
        setRole('SUPPORT');
        setOpen(false);
      }
    });
  };
  return (
    <details
      className="pc-disclosure pc-invite"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="uv-btn uv-btn--action">Invite a member</summary>
      <form method="post" className="pc-form pc-invite__form" onSubmit={onSubmit} noValidate>
        <TextField label="Their name" name="displayName" autoComplete="off" required />
        <TextField
          label="Their work email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <RoleSelect id="invite-role" value={role} onChange={setRole} />
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" pending={busy}>
            Send the invitation
          </Button>
        </div>
      </form>
    </details>
  );
}
