import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { tenantProfile } from '@/lib/tenant';
import { ConfirmToSee, ExportPanel } from './ExportPanel';

export const metadata: Metadata = { title: 'Data export' };

/**
 * Spec 0038 Q7, Q8: the institution's full export, for its IT Admins. `data.export.request` is step-up flagged, so the
 * first load usually answers 428 and the page asks the person to confirm it's them first.
 */
export default async function ExportPage() {
  await requireSession();
  const [res, { profile }] = await Promise.all([serverGet((api) => api.GET('/api/v1/exports')), tenantProfile()]);
  if (res.status !== 200 && res.status !== 428) notFound();
  const name = profile?.legalName ?? 'your institution';
  return (
    <div className="page">
      <h1 className="page__title">Data export</h1>
      <p className="page__lede">A full copy of {name}’s records and documents, locked with a passphrase, for moving to another system or keeping.</p>
      {res.status === 428 || !res.data ? <ConfirmToSee /> : <ExportPanel initial={res.data} institution={name} closesAt={profile?.closesAt ?? null} />}
    </div>
  );
}
