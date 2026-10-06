import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { DocumentsPanel } from './DocumentsPanel';

export const metadata: Metadata = { title: 'My documents' };

/** Spec 0010 FU9: upload → scanning status → authorised download → deletion. Own files only (D2). */
export default async function DocumentsPage() {
  await requireSession();
  const res = await serverGet((api) => api.GET('/api/v1/files'));
  if (res.status !== 200 || !res.data) notFound();
  return (
    <div className="page">
      <h1 className="page__title">My documents</h1>
      <p className="page__lede">Upload documents your institution asks for. Every file is checked for viruses before anyone, including you, can open it.</p>
      <DocumentsPanel initial={res.data.data} />
    </div>
  );
}
