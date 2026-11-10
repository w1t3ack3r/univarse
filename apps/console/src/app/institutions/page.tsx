import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../components/console-shell';
import { InstitutionsView } from './institutions-view';

export const metadata: Metadata = { title: 'Institutions' };

export default function InstitutionsPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <InstitutionsView />
      </Suspense>
    </ConsoleShell>
  );
}
