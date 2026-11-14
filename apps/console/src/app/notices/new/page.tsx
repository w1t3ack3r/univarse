import type { Metadata } from 'next';
import { ConsoleShell } from '../../../components/console-shell';
import { NewNoticeView } from './new-view';

export const metadata: Metadata = { title: 'Write a notice' };

export default function NewNoticePage() {
  return (
    <ConsoleShell>
      <NewNoticeView />
    </ConsoleShell>
  );
}
