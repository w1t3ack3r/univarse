import type { Metadata } from 'next';
import { LogoutButton } from '@/components/LogoutButton';

export const metadata: Metadata = { title: 'Set up multi-factor authentication' };

/** Enrolment UI arrives in spec 0005 PR B (W13). Until then a restricted session can only sign out. */
export default function MfaSetupPage() {
  return (
    <div className="grid gap-4">
      <h1 id="auth-heading" className="text-2xl font-semibold">
        Set up multi-factor authentication
      </h1>
      <p>
        Your role needs multi-factor authentication. Setting it up in the browser is coming next. For now, ask your ICT
        unit for help.
      </p>
      <LogoutButton variant="ghost" />
    </div>
  );
}
