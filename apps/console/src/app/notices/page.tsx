import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { NoticesView } from './notices-view';

export const metadata: Metadata = { title: 'Notices' };

export default function NoticesPage() {
  return (
    <ConsoleShell>
      <NoticesView />
    </ConsoleShell>
  );
}
