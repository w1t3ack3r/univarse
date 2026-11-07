import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { SecurityView } from './security-view';

export const metadata: Metadata = { title: 'Security' };

export default function SecurityPage() {
  return (
    <ConsoleShell>
      <SecurityView />
    </ConsoleShell>
  );
}
