import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConsoleShell, PageSkeleton } from '../../../components/console-shell';
import { NoticeView } from './notice-view';

export const metadata: Metadata = { title: 'Notice' };

export default function NoticePage() {
  return (
    <ConsoleShell>
      <Suspense fallback={<PageSkeleton />}>
        <NoticeView />
      </Suspense>
    </ConsoleShell>
  );
}
