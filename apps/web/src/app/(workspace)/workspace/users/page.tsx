import { Card } from '@univarse/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ResponseBody } from '@univarse/api-client';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Users' };

type UserStatus = ResponseBody<'/api/v1/users', 'get'>['data'][number]['status'];

/** Every status the API can return has a label (the generated type makes a missing one a compile error). */
const STATUS: Record<UserStatus, { label: string; on: boolean }> = {
  ACTIVE: { label: 'Active', on: true },
  PENDING_ACTIVATION: { label: 'Not activated yet', on: false },
  DISABLED: { label: 'Disabled', on: false },
  LOCKED: { label: 'Locked', on: false },
};

/** Permission-gated (identity.user.view). The API decides; a refusal renders as not found. */
export default async function UsersPage() {
  await requireSession();
  const res = await serverGet((api) => api.GET('/api/v1/users'));
  if (res.status !== 200 || !res.data) notFound();
  return (
    <div className="page">
      <h1 className="page__title">Users</h1>
      <p className="page__lede">Everyone with an account at your institution. Accounts stay “not activated” until the person sets their password.</p>
      <Card>
        <div className="scroll-x">
          <table className="table">
            <caption className="uv-visually-hidden">Users in this institution</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Matric or staff number</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {res.data.data.map((u) => {
                const s = STATUS[u.status];
                return (
                  <tr key={u.id}>
                    <td>{u.displayName}</td>
                    <td>{u.username}</td>
                    <td>
                      <span className={`status ${s.on ? 'status--on' : 'status--off'}`}>{s.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
