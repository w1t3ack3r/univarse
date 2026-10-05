'use client';

import { ProblemState, type BoundaryProps } from '@/components/ProblemState';

/** Catches a failing shell (a layout's session or tenant check): no shell, nothing personal. */
export default function RootError(props: BoundaryProps) {
  return (
    <main id="main" className="problem-page">
      <span className="uv-pill auth__trust">
        <img src="/brand/icon-deep.svg" alt="" width={18} height={18} />
        Secured by UniVarse
      </span>
      <ProblemState {...props} />
    </main>
  );
}
