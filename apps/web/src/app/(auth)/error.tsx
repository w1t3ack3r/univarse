'use client';

import { ProblemState, type BoundaryProps } from '@/components/ProblemState';

/** A sign-in page failed (e.g. two-step setup's session check): the problem shows in the sign-in shell. */
export default function AuthError(props: BoundaryProps) {
  return <ProblemState {...props} />;
}
