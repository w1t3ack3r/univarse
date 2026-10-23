import { ArrowLeft, ArrowRight, buttonClass, Card, Notice } from '@univarse/ui';
import { messageFor } from '@univarse/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
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

const FIRST_PAGE = '/workspace/users';

/**
 * Permission-gated (identity.user.view). The API decides; a refusal renders as not found. Spec 0021: a page at a
 * time; the cursor in this page's URL is the API's opaque one (a row id, never a username).
 */
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  await requireSession();
  const { cursor } = await searchParams;
  const after = typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
  const res = await serverGet((api) => api.GET('/api/v1/users', { params: { query: after ? { cursor: after } : {} } }));
  // A 400's body is the Problem (its `code`), never the list.
  const problem = res.status === 400 && res.body && 'code' in res.body ? res.body.code : undefined;
  const code = typeof problem === 'string' ? problem : undefined;
  if (code === 'request.invalid_cursor' || code === 'request.invalid') {
    // A stale or edited page link: say so plainly and offer the way back (docs/11 §2: the message for the code).
    return (
      <div className="page">
        <h1 className="page__title">Users</h1>
        <Card>
          <Notice requestId={res.requestId}>{messageFor('request.invalid_cursor')}</Notice>
          <p className="pager">
            <Link className={buttonClass('quiet')} href={FIRST_PAGE}>
              <ArrowLeft size={18} />
              Back to the first page
            </Link>
          </p>
        </Card>
      </div>
    );
  }
  if (res.status !== 200 || !res.data) notFound();
  const { data, page } = res.data;
  return (
    <div className="page">
      <h1 className="page__title">Users</h1>
      <p className="page__lede">Everyone with an account at your institution, by matric or staff number. Accounts stay “not activated” until the person sets their password.</p>
      <Card>
        <div className="scroll-x">
          <table className="table">
            <caption className="uv-visually-hidden">Users in this institution{after ? ', continued' : ''}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Matric or staff number</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => {
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
      {(after || page.nextCursor) && (
        <nav className="pager" aria-label="Pages of users">
          {after && (
            <Link className={buttonClass('quiet')} href={FIRST_PAGE}>
              <ArrowLeft size={18} />
              Back to the first page
            </Link>
          )}
          {page.nextCursor && (
            <Link className={`${buttonClass('action')} pager__next`} href={`${FIRST_PAGE}?cursor=${encodeURIComponent(page.nextCursor)}`}>
              Next page
              <ArrowRight size={18} />
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
