import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { AccountView } from './account-view';

export const metadata: Metadata = { title: 'Your account' };

export default function AccountPage() {
  return (
    <ConsoleShell>
      <AccountView />
    </ConsoleShell>
  );
}
