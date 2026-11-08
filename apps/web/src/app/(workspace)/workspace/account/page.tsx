import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { EmailCard } from './EmailCard';

export const metadata: Metadata = { title: 'Your account' };

/** Spec 0032: every signed-in user's own page. The API decides; a refusal renders as not found. */
export default async function AccountPage() {
  await requireSession();
  const res = await serverGet((api) => api.GET('/api/v1/auth/email'));
  if (res.status !== 200 || !res.data) notFound();
  return (
    <div className="page">
      <h1 className="page__title">Your account</h1>
      <EmailCard address={res.data.address} pending={res.data.pending?.address ?? null} />
    </div>
  );
}
