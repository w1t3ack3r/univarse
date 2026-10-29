// Shared frames for the stories (spec 0026 SB2): the phone width every component must hold at.
import type { ReactNode } from 'react';

/** The narrowest phone the product supports (docs/11): 360 px. */
export function Phone({ children }: { children: ReactNode }) {
  return <div style={{ width: 360, maxWidth: '100%' }}>{children}</div>;
}
