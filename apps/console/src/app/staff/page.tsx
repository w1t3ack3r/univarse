import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { StaffView } from './staff-view';

export const metadata: Metadata = { title: 'Staff' };

export default function StaffPage() {
  return (
    <ConsoleShell>
      <StaffView />
    </ConsoleShell>
  );
}
