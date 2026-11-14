'use client';

import { securityEventText, type PlatformInbox, type PlatformInboxItem } from '@univarse/contracts';
import { Activity, AlertCircle, ArrowRight, Building, Check, Clock, Notice, Users } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { STEP } from '../institutions/labels';
import { APPROVAL_KIND_LABEL, APPROVAL_STATUS, timeLeft } from '../../lib/approvals';
import { clockText, INCIDENT_STATUS, SEVERITY } from '../../lib/incidents';
import { api, ApiError, asApiError } from '../../lib/api';
import { when } from '../../lib/device';


/**
 * Spec 0037 Q15 (E25): what needs this member now, in one place. Each item comes from the screen it belongs to and
 * leaves when its cause is resolved; there's nothing to mark as read.
 */
export function InboxView() {
  const [inbox, setInbox] = useState<PlatformInbox | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<PlatformInbox>('GET', '/inbox')
      .then(setInbox)
      .catch((err: unknown) => setError(asApiError(err)));
  }, []);

  return (
    <section className="pc-section" aria-labelledby="inbox-title">
      <h1 id="inbox-title" className="pc-section__title">
        Inbox
      </h1>
      <p className="pc-section__lead">What needs you now. Each item leaves on its own once it’s dealt with.</p>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {inbox === null ? (
        error ? null : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
      ) : inbox.items.length === 0 ? (
        <div className="pc-empty pc-inbox__clear">
          <span className="uv-icon-tile">
            <Check />
          </span>
          <p>Nothing needs you right now.</p>
        </div>
      ) : (
        <ul className="pc-list">
          {inbox.items.map((item) => (
            <li key={keyOf(item)}>
              <Item item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function keyOf(i: PlatformInboxItem): string {
  switch (i.type) {
    case 'approval_waiting':
    case 'approval_decided':
      return `${i.type}:${i.approvalId}`;
    case 'provisioning_failed':
      return `${i.type}:${i.tenant.id}`;
    case 'security_act':
      return `${i.type}:${i.event}:${i.tenant?.id ?? ''}`;
    case 'incident_open':
      return `${i.type}:${i.incidentId}`;
    case 'maintenance_soon':
      return `${i.type}:${i.noticeId}`;
  }
}

function Row({ href, icon, title, meta, chip }: { href: string; icon: ReactNode; title: string; meta: string; chip?: ReactNode }) {
  return (
    <Link className="pc-list__row" href={href}>
      <span className="uv-icon-tile">{icon}</span>
      <span className="pc-list__text">
        <span className="pc-list__title">{title}</span>
        <span className="pc-list__meta">{meta}</span>
      </span>
      {chip}
      <ArrowRight size={18} />
    </Link>
  );
}

function Item({ item }: { item: PlatformInboxItem }) {
  switch (item.type) {
    case 'incident_open': {
      const clock = item.breachDeadline ? clockText(item.breachDeadline) : null;
      return (
        <Row
          href={`/incidents/${item.incidentId}`}
          icon={<AlertCircle />}
          title={`${SEVERITY[item.severity].label}: ${item.title}`}
          meta={`${INCIDENT_STATUS[item.status].label}, last update ${when(item.lastUpdateAt)}.${clock ? ` Personal data may be involved: ${clock.text}.` : ''}`}
          chip={<span className={`pc-status ${clock?.overdue ? 'pc-status--bad' : INCIDENT_STATUS[item.status].tone}`}>{clock ? 'Clock' : 'Open'}</span>}
        />
      );
    }
    case 'maintenance_soon':
      return (
        <Row
          href={`/notices/${item.noticeId}`}
          icon={<Clock />}
          title={`Maintenance soon: ${item.title}`}
          meta={`Starts ${when(item.startsAt)}, at ${item.institutions === 1 ? '1 institution' : `${String(item.institutions)} institutions`}.`}
          chip={<span className="pc-status pc-status--wait">Soon</span>}
        />
      );
    case 'approval_waiting':
      return (
        <Row
          href={`/approvals/${item.approvalId}`}
          icon={<Users />}
          title={`${APPROVAL_KIND_LABEL[item.kind]}: your decision`}
          meta={`${item.requestedBy.name ?? 'A former member'} asked. It expires ${timeLeft(item.expiresAt)}.`}
          chip={<span className="pc-status pc-status--wait">Decide</span>}
        />
      );
    case 'approval_decided': {
      const s = APPROVAL_STATUS[item.status];
      return <Row href={`/approvals/${item.approvalId}`} icon={<Users />} title={`${APPROVAL_KIND_LABEL[item.kind]}: your request`} meta={`Decided on ${when(item.decidedAt)}.`} chip={<span className={`pc-status ${s.tone}`}>{s.text}</span>} />;
    }
    case 'provisioning_failed':
      return (
        <Row
          href={`/institutions/${item.tenant.id}`}
          icon={<Building />}
          title={`${item.tenant.name ?? item.tenant.slug ?? 'An institution'}: provisioning stopped`}
          meta={`Stopped at “${STEP[item.step]?.label ?? item.step}” on ${when(item.failedAt)}. Resume it from the institution’s page.`}
          chip={<span className="pc-status pc-status--off">Stopped</span>}
        />
      );
    case 'security_act': {
      const text = securityEventText(item.event);
      const where = item.tenant ? ` at ${item.tenant.name ?? item.tenant.slug ?? 'an institution'}` : '';
      return (
        <Row
          href="/security"
          icon={<Activity />}
          title={`${text.label}${where}`}
          meta={`${String(item.count)} in the last day, last ${when(item.lastSeenAt)}. ${text.todo}`}
          chip={<span className="pc-status pc-status--bad">Act</span>}
        />
      );
    }
  }
}
