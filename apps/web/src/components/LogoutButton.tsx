'use client';

import { Button } from '@univarse/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function LogoutButton({ variant = 'accent' }: { variant?: 'accent' | 'ghost' }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant={variant}
      pending={pending}
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
      Sign out
    </Button>
  );
}
