import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../components/console-shell';
import { AuditView } from './audit-view';

export const metadata: Metadata = { title: 'Audit log' };

export default function AuditPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <AuditView />
      </Suspense>
    </ConsoleShell>
  );
}
