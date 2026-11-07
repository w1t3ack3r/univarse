import type { Metadata } from 'next';
import { ConfirmForm } from './confirm-form';

export const metadata: Metadata = { title: 'Confirm a new address' };

export default function ContactChangePage() {
  return <ConfirmForm />;
}
