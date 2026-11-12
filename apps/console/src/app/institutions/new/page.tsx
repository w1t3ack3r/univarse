import type { Metadata } from 'next';
import { ConsoleShell } from '../../../components/console-shell';
import { NewInstitutionView } from './new-view';

export const metadata: Metadata = { title: 'New institution' };

export default function NewInstitutionPage() {
  return (
    <ConsoleShell>
      <NewInstitutionView />
    </ConsoleShell>
  );
}
