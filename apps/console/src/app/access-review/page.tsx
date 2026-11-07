import type { Metadata } from 'next';
import { ConsoleShell } from '../../components/console-shell';
import { ReviewView } from './review-view';

export const metadata: Metadata = { title: 'Access review' };

export default function AccessReviewPage() {
  return (
    <ConsoleShell>
      <ReviewView />
    </ConsoleShell>
  );
}
