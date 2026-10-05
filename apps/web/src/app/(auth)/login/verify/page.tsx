import type { Metadata } from 'next';
import { VerifyForm } from './VerifyForm';

export const metadata: Metadata = { title: 'Confirm it’s you' };

export default function VerifyPage() {
  return <VerifyForm />;
}
