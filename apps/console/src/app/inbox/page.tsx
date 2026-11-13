import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Inbox' };

export default function InboxPage() {
  return (
    <ConsoleShell>
      <InboxView />
    </ConsoleShell>
  );
}
