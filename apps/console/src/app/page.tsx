import type { Metadata } from 'next';
import { ConsoleShell } from '../components/console-shell';
import { Overview } from './overview';

// The title names the console in the server-rendered page itself: the image and stack smokes look for it there,
// before any script has run (spec 0027 P6).
export const metadata: Metadata = { title: 'Platform console' };

export default function ConsoleHome() {
  return (
    <ConsoleShell>
      <Overview />
    </ConsoleShell>
  );
}
