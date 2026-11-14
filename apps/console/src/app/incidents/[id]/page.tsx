import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../../components/console-shell';
import { IncidentView } from './incident-view';

export const metadata: Metadata = { title: 'Incident' };

export default function IncidentPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <IncidentView />
      </Suspense>
    </ConsoleShell>
  );
}
