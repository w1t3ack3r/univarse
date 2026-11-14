'use client';

import { Close } from '@univarse/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { client, unwrap } from '@/lib/client-api';

/** Spec 0037 Q10: hides one notice for this person. It stays recorded; the page reads the list again. */
export function DismissNotice({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="notice__dismiss"
      aria-label={`Dismiss: ${title}`}
      disabled={pending}
      onClick={() => {
        setPending(true);
        // Gone either way: a notice already withdrawn or dismissed elsewhere answers 404, and the refresh drops it.
        void unwrap(client.POST('/api/v1/notices/{id}/dismiss', { params: { path: { id } } }))
          .catch(() => undefined)
          .then(() => router.refresh())
          .finally(() => setPending(false));
      }}
    >
      <Close size={18} />
    </button>
  );
}
