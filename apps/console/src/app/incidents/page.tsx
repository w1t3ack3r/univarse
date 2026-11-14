import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { IncidentsView } from './incidents-view';

export const metadata: Metadata = { title: 'Incidents' };

export default function IncidentsPage() {
  return (
    <ConsoleShell>
      <IncidentsView />
    </ConsoleShell>
  );
}
