import { messageFor } from '@univarse/contracts';
import { Alert } from '@univarse/ui';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { tenantProfile } from '@/lib/tenant';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const { profile, code } = await tenantProfile();
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <Logo tone="deep" height={34} />
      <section className="rounded-2xl bg-surface p-6 shadow-sm sm:p-8" aria-labelledby="auth-heading">
        {profile ? (
          <>
            <p className="mb-1 text-sm text-muted">{profile.legalName}</p>
            {children}
          </>
        ) : (
          <Alert>{messageFor(code)}</Alert>
        )}
      </section>
      <p className="text-center text-xs text-muted">UniVarse · Secure sign-in</p>
    </main>
  );
}
