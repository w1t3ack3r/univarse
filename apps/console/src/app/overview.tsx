'use client';

import { ArrowRight, ShieldCheck, Users } from '@univarse/ui';
import Link from 'next/link';
import { useMe } from '../components/console-shell';

/**
 * The signed-in home (spec 0028 Q16): what this member can do here today, and nothing that doesn't exist yet. Each
 * later slice adds its own row (the tenant registry, provisioning) when it ships, never before.
 */
export function Overview() {
  const me = useMe();
  const canSeeStaff = me.permissions.includes('platform.staff.read');
  return (
    <section className="pc-section" aria-labelledby="ov-title">
      <h1 id="ov-title" className="pc-section__title">
        Platform console
      </h1>
      <p className="pc-section__lead">
        You’re signed in with your authenticator. Sessions end after 15 minutes without activity.
      </p>
      <ul className="pc-list">
        <li>
          <Link className="pc-list__row" href="/account">
            <span className="uv-icon-tile">
              <ShieldCheck />
            </span>
            <span className="pc-list__text">
              <span className="pc-list__title">Your account</span>
              <span className="pc-list__meta">
                Where you’re signed in, and your recovery codes.
              </span>
            </span>
            <ArrowRight size={18} />
          </Link>
        </li>
        {canSeeStaff ? (
          <li>
            <Link className="pc-list__row" href="/staff">
              <span className="uv-icon-tile">
                <Users />
              </span>
              <span className="pc-list__text">
                <span className="pc-list__title">Staff</span>
                <span className="pc-list__meta">
                  {me.permissions.includes('platform.staff.manage')
                    ? 'Who can reach the console: invite, change roles, remove access.'
                    : 'Who can reach the console, and their roles.'}
                </span>
              </span>
              <ArrowRight size={18} />
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
