import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { AuditView } from './audit-view';

export const metadata: Metadata = { title: 'Audit log' };

export default function AuditPage() {
  return (
    <ConsoleShell>
      <AuditView />
    </ConsoleShell>
  );
}
