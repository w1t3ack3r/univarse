import type { Metadata } from 'next';
import { CodeFlow } from '@/components/CodeFlow';
import { tenantProfile } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Reset your password' };

export default async function ResetPasswordPage() {
  const { profile } = await tenantProfile();
  return <CodeFlow kind="reset" institution={profile?.legalName ?? 'your institution'} />;
}
