import type { Metadata } from 'next';
import { CodeFlow } from '@/components/CodeFlow';
import { tenantProfile } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Activate your account' };

export default async function ActivatePage() {
  const { profile } = await tenantProfile();
  return <CodeFlow kind="activation" institution={profile?.legalName ?? 'your institution'} />;
}
