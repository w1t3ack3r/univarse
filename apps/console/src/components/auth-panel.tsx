import { Card } from '@univarse/ui';
import type { ReactNode } from 'react';

/**
 * The signed-out screens' frame (spec 0028 Q16): one task card under the platform bar, with the links that belong to
 * the task beneath it, and one plain line about who this is for. No institution, no hero: this is a staff door.
 */
export function AuthPanel({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="pc-auth">
      <Card className="pc-card">{children}</Card>
      {below ? <div className="pc-auth__more">{below}</div> : null}
      <p className="pc-auth__note">
        For UniVarse staff only. Every sign-in and change here is recorded.
      </p>
    </div>
  );
}
