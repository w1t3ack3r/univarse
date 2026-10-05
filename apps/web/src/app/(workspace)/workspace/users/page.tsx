import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Users' };

interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
}

/** First permission-gated page (identity.user.view). The API decides; a refusal renders as not found. */
export default async function UsersPage() {
  await requireSession();
  const res = await serverApi<{ data: UserRow[] }>('/api/v1/users');
  if (res.status !== 200 || !res.body) notFound();
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Users</h1>
      <div className="overflow-x-auto rounded-xl bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="uv-visually-hidden">Users in this institution</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="p-3 font-semibold">Name</th>
              <th scope="col" className="p-3 font-semibold">Username</th>
              <th scope="col" className="p-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {res.body.data.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-0">
                <td className="p-3">{u.displayName}</td>
                <td className="p-3">{u.username}</td>
                <td className="p-3">{u.status.toLowerCase().replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
