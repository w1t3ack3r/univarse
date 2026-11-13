import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../../components/console-shell';
import { ApprovalView } from './approval-view';

export const metadata: Metadata = { title: 'Approval' };

export default function ApprovalPage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <ApprovalView />
      </Suspense>
    </ConsoleShell>
  );
}
