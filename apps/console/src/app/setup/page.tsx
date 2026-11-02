import type { Metadata } from 'next';
import { SetupFlow } from './setup-flow';

export const metadata: Metadata = { title: 'Set up your authenticator' };

export default function SetupPage() {
  return <SetupFlow />;
}
