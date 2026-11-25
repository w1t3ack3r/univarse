import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { ShardsView } from './shards-view';

export const metadata: Metadata = { title: 'Shards' };

export default function ShardsPage() {
  return (
    <ConsoleShell>
      <ShardsView />
    </ConsoleShell>
  );
}
