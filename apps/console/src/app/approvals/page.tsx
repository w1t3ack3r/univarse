import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { ApprovalsView } from './approvals-view';

export const metadata: Metadata = { title: 'Approvals' };

export default function ApprovalsPage() {
  return (
    <ConsoleShell>
      <ApprovalsView />
    </ConsoleShell>
  );
}
