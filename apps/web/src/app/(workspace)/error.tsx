'use client';

import { ProblemState, type BoundaryProps } from '@/components/ProblemState';

/** A workspace page failed after the shell loaded: the problem shows inside the shell. */
export default function WorkspaceError(props: BoundaryProps) {
  return (
    <div className="page">
      <ProblemState {...props} />
    </div>
  );
}
