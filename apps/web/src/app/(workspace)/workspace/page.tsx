import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Home' };

export default async function WorkspaceHome() {
  const me = await requireSession();
  return (
    <div className="grid max-w-3xl gap-4">
      <h1 className="text-2xl font-semibold">
        Welcome, <span className="uv-highlight">{me.displayName}</span>
      </h1>
      <p className="text-muted">
        Your workspace shows only what your role and your institution&apos;s products allow. More modules appear here as
        they are switched on.
      </p>
    </div>
  );
}
