import type { Metadata } from 'next';
import { ConsoleShell } from '../../../components/console-shell';
import { OpenIncidentView } from '../open-view';

export const metadata: Metadata = { title: 'Open an incident' };

export default function OpenIncidentPage() {
  return (
    <ConsoleShell>
      <OpenIncidentView />
    </ConsoleShell>
  );
}
