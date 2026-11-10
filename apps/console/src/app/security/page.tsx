import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../components/console-shell';
import { SecurityView } from './security-view';

export const metadata: Metadata = { title: 'Security' };

export default function SecurityPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <SecurityView />
      </Suspense>
    </ConsoleShell>
  );
}
