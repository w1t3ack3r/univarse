'use client';

import { messageFor } from '@univarse/contracts';
import { Button, Card, Notice, Refresh } from '@univarse/ui';
import { problemFromDigest } from '@/lib/session-check';

/** Next.js error-boundary props. `retry` re-fetches the segment from the server, then re-renders it. */
export interface BoundaryProps {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}

/**
 * What an error boundary shows (docs/11 §2): the message for the problem code, the support reference,
 * and a retry. Nothing personal: it renders when the session check itself could not finish (spec 0005 W7).
 */
export function ProblemState({ error, retry }: BoundaryProps) {
  const { code, requestId } = problemFromDigest(error.digest);
  return (
    <Card className="problem" data-testid="problem-state">
      <h1 className="auth__heading">We couldn’t open this page</h1>
      <Notice requestId={requestId}>{messageFor(code)}</Notice>
      <p className="problem__hint">If it keeps happening, give the support reference to your ICT unit.</p>
      <div>
        <Button onClick={retry}>
          <Refresh size={18} />
          Try again
        </Button>
      </div>
    </Card>
  );
}
