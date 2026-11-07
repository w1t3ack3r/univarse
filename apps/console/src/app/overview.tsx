'use client';

import type { PlatformAccessReview } from '@univarse/contracts';
import { Activity, ArrowRight, ClipboardCheck, ScrollText, ShieldCheck, Users } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useMe } from '../components/console-shell';

/**
 * The signed-in home (spec 0028 Q16): what this member can do here today, and nothing that doesn't exist yet. Each
 * later slice adds its own row (the tenant registry, provisioning) when it ships, never before.
 */
export function Overview() {
  const me = useMe();
  const canSeeStaff = me.permissions.includes('platform.staff.read');
  const canAttest = me.permissions.includes('platform.access_review.attest');
  const [review, setReview] = useState<PlatformAccessReview['status'] | null>(null);

  // Spec 0031 Q15: due or overdue, to the people who can do something about it.
  useEffect(() => {
    if (!canAttest) return;
    api<PlatformAccessReview>('GET', '/access-review')
      .then((r) => setReview(r.status))
      .catch(() => undefined); // the row still links to the page, which reports a failed read
  }, [canAttest]);

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
        {me.permissions.includes('platform.audit.read') ? (
          <li>
            <Link className="pc-list__row" href="/audit">
              <span className="uv-icon-tile">
                <ScrollText />
              </span>
              <span className="pc-list__text">
                <span className="pc-list__title">Audit log</span>
                <span className="pc-list__meta">What staff and the system have done, and whether the record is intact.</span>
              </span>
              <ArrowRight size={18} />
            </Link>
          </li>
        ) : null}
        {me.permissions.includes('platform.security.read') ? (
          <li>
            <Link className="pc-list__row" href="/security">
              <span className="uv-icon-tile">
                <Activity />
              </span>
              <span className="pc-list__text">
                <span className="pc-list__title">Security</span>
                <span className="pc-list__meta">What the platform refused or noticed, and what needs someone.</span>
              </span>
              <ArrowRight size={18} />
            </Link>
          </li>
        ) : null}
        {me.permissions.includes('platform.access_review.read') ? (
          <li>
            <Link className="pc-list__row" href="/access-review">
              <span className="uv-icon-tile">
                <ClipboardCheck />
              </span>
              <span className="pc-list__text">
                <span className="pc-list__title">Access review</span>
                <span className="pc-list__meta">Each month, confirm everyone who can reach the console is still meant to.</span>
              </span>
              {review === 'due' ? <span className="pc-status pc-status--wait">Due</span> : null}
              {review === 'overdue' ? <span className="pc-status pc-status--bad">Overdue</span> : null}
              <ArrowRight size={18} />
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
