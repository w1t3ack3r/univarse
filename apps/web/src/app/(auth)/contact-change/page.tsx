import type { Metadata } from 'next';
import { ConfirmForm } from './ConfirmForm';

export const metadata: Metadata = { title: 'Confirm a new address' };

export default function ContactChangePage() {
  return <ConfirmForm />;
}
