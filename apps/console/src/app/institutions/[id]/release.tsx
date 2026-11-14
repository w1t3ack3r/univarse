'use client';

import { Megaphone, Clock } from '@univarse/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api } from '../../../lib/api';
import { when } from '../../../lib/device';
import { NOTICE_KIND, RING } from '../../../lib/notices';
import type { Changing, Tenant } from './institution-view';

/**
 * Spec 0037 Q11, Q12: the institution's release ring and the notices it got. The ring is two choices, set with a
 * step-up by those who manage releases; everyone else reads it. Notices list newest first, each linking to its record.
 */
export function ReleaseSection({ tenant, canRing, changing }: { tenant: Tenant; canRing: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);

  const setRing = (ring: 'PILOT' | 'GENERAL') => {
    if (ring === tenant.releaseRing || busy) return;
    setBusy(true);
    stepUp(async () => {
      await api('PUT', `/tenants/${tenant.id}/ring`, { ring });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`${tenant.shortName} is in the ${RING[ring].label.toLowerCase()} ring.`);
      })
      .catch((err: unknown) => changing.failed(err))
      .finally(() => setBusy(false));
  };

  return (
    <section className="pc-section" aria-labelledby="t-release">
      <h2 id="t-release" className="pc-section__title">
        Releases and notices
      </h2>
      <div className="pc-release">
        <div className="pc-release__ring">
          <p className="uv-field__label" id="ring-label">
            Release ring
          </p>
          {canRing ? (
            <div className="pc-seg" role="group" aria-labelledby="ring-label">
              {(['PILOT', 'GENERAL'] as const).map((r) => (
                <button key={r} type="button" className="pc-seg__opt" aria-pressed={tenant.releaseRing === r} disabled={busy} onClick={() => setRing(r)}>
                  {RING[r].label}
                </button>
              ))}
            </div>
          ) : (
            <p className="pc-release__value">{RING[tenant.releaseRing].label}</p>
          )}
          <p className="pc-note">{RING[tenant.releaseRing].about}</p>
        </div>
        <div className="pc-release__notices">
          <p className="uv-field__label">Notices it got</p>
          {tenant.notices.length === 0 ? (
            <p className="pc-note">None yet.</p>
          ) : (
            <ul className="pc-list">
              {tenant.notices.map((n) => (
                <li key={n.id}>
                  <Link className="pc-list__row" href={`/notices/${n.id}`}>
                    <span className="uv-icon-tile">{n.kind === 'MAINTENANCE' ? <Clock /> : <Megaphone />}</span>
                    <span className="pc-list__text">
                      <span className="pc-list__title">{n.title}</span>
                      <span className="pc-list__meta">
                        {NOTICE_KIND[n.kind].label}, published {when(n.publishedAt)}
                      </span>
                    </span>
                    <span className={`pc-status ${n.live ? 'pc-status--on' : 'pc-status--off'}`}>{n.withdrawnAt ? 'Withdrawn' : n.live ? 'Showing' : 'Ended'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
