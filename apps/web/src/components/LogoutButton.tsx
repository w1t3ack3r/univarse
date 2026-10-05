'use client';

import { Button, LogOut } from '@univarse/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function LogoutButton({ variant = 'quiet', compact = false }: { variant?: 'action' | 'quiet' | 'plain'; compact?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant={variant}
      pending={pending}
      aria-label={compact ? 'Sign out' : undefined}
      onClick={() => {
        setPending(true);
        // Signed out either way: an expired session also lands on the login page.
        void api('POST', '/api/v1/auth/logout')
          .catch(() => undefined)
          .then(() => {
            router.replace('/login');
            router.refresh();
          });
      }}
    >
      {pending ? null : <LogOut size={18} />}
      {compact ? null : 'Sign out'}
    </Button>
  );
}
