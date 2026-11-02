import type { Metadata } from 'next';
import { VerifyForm } from './verify-form';

export const metadata: Metadata = { title: 'Confirm sign-in' };

export default function VerifyPage() {
  return <VerifyForm />;
}
