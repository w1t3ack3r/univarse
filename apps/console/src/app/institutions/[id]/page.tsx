import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../../components/console-shell';
import { InstitutionView } from './institution-view';

export const metadata: Metadata = { title: 'Institution' };

export default function InstitutionPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <InstitutionView />
      </Suspense>
    </ConsoleShell>
  );
}
