'use client';

import type { PlatformTenantDetail } from '@univarse/contracts';
import { Notice } from '@univarse/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import { OWNERSHIP, STATUS, TYPE } from '../labels';
import { BrandingSection } from './branding';
import { ProductsSection } from './products';
import { ProfileForm, RegulatoryForm } from './forms';
import { GoLiveSection } from './go-live';
import { ProvisioningSection } from './provisioning';
import { ReleaseSection } from './release';
import { SuspensionSection } from './suspension';

export type Tenant = PlatformTenantDetail;

export interface Changing {
  /** A change landed: say so, and read the institution again. */
  readonly changed: (message: string) => void;
  /** It didn't. A stale form reloads what's true now. */
  readonly failed: (err: unknown) => void;
  /** Read the institution again, quietly (a section waiting on the worker). */
  readonly reload: () => void;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Spec 0033 Q4: one place to answer "what's the state of this institution?". What it is first, then what it has, then
 * what can be changed. Staff who can't change anything see the same page with the forms left out. A suspension leads the
 * page while it lasts (spec 0037 Q6); otherwise suspending sits with the other changes. Offboarding comes with S7.
 */
export function InstitutionView() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<Tenant | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const canRead = me.permissions.includes('platform.tenant.read');
  const closed = t?.status === 'ARCHIVED' || t?.status === 'PURGED';
  const canEdit = me.permissions.includes('platform.tenant.edit') && !closed;
  const canEntitle = me.permissions.includes('platform.tenant.entitlements') && !closed;
  const canProvision = me.permissions.includes('platform.tenant.provision');
  const canGoLive = me.permissions.includes('platform.tenant.go_live');
  const canSuspend = me.permissions.includes('platform.tenant.suspend');
  const canRing = me.permissions.includes('platform.release.manage') && !closed;

  const load = useCallback(() => {
    api<Tenant>('GET', `/tenants/${id}`)
      .then(setT)
      .catch((err: unknown) => {
        const failed = asApiError(err);
        if (failed.status === 404 || failed.status === 400) setGone(true);
        else setError(failed);
      });
  }, [id]);
  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  const changing: Changing = {
    changed: (message) => {
      setError(null);
      setDone(message);
      load();
    },
    failed: (err) => {
      setDone(null);
      const e = asApiError(err);
      setError(e);
      if (e.status === 412) load();
    },
    reload: load,
  };

  if (!canRead || gone) return <NothingHere />;
  if (!t) return error ? <Notice requestId={error.requestId}>{error.message}</Notice> : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />;

  const s = STATUS[t.status];
  return (
    <>
      <section className="pc-section" aria-labelledby="t-title">
        <p className="pc-note">
          <Link className="uv-link" href="/institutions">
            All institutions
          </Link>
        </p>
        <div className="pc-section__head">
          <div>
            <h1 id="t-title" className="pc-section__title">
              {t.legalName}
            </h1>
            <p className="pc-section__lead">
              {t.shortName}, {TYPE[t.type] ?? t.type}, {t.regulatory.regulator}
            </p>
          </div>
          <span className={`pc-status ${s?.tone ?? 'pc-status--wait'}`}>{s?.label ?? t.status}</span>
        </div>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <dl className="pc-facts pc-facts--card">
          <Fact term="Subdomain">{t.slug}</Fact>
          <Fact term="Ownership">{OWNERSHIP[t.ownership] ?? t.ownership}</Fact>
          <Fact term="Tier">{t.tier === 'POOLED' ? 'Shared' : 'Dedicated'}</Fact>
          <Fact term="Database">
            {t.shard.name}, {t.shard.region}
          </Fact>
          <Fact term="Domains">{t.domains.length ? t.domains.map((d) => d.hostname).join(', ') : 'None'}</Fact>
          <Fact term="Created">{when(t.createdAt)}</Fact>
          {t.template ? <Fact term="Template">{t.template}</Fact> : null}
        </dl>
        <p className="pc-note">
          {me.permissions.includes('platform.audit.read') ? (
            <Link className="uv-link" href={`/audit?tenantId=${t.id}`}>
              This institution in the audit log
            </Link>
          ) : null}
          {me.permissions.includes('platform.audit.read') && me.permissions.includes('platform.security.read') ? ' · ' : null}
          {me.permissions.includes('platform.security.read') ? (
            <Link className="uv-link" href={`/security?tenantId=${t.id}`}>
              Its security events
            </Link>
          ) : null}
        </p>
      </section>

      {t.status === 'SUSPENDED' ? <SuspensionSection tenant={t} canSuspend={canSuspend} changing={changing} /> : null}
      <ProvisioningSection tenant={t} canProvision={canProvision} changing={changing} />
      {t.status === 'ONBOARDING' ? <GoLiveSection tenant={t} canGoLive={canGoLive} changing={changing} /> : null}

      <ProductsSection tenant={t} canEntitle={canEntitle} changing={changing} />
      <ReleaseSection tenant={t} canRing={canRing} changing={changing} />

      {canEdit ? (
        <div className="pc-twin">
          <ProfileForm key={`p${String(t.version)}`} tenant={t} changing={changing} />
          <RegulatoryForm key={`r${String(t.regulatory.version)}`} tenant={t} changing={changing} />
        </div>
      ) : null}
      {t.status !== 'SUSPENDED' ? <SuspensionSection tenant={t} canSuspend={canSuspend} changing={changing} /> : null}
      <BrandingSection key={`b${t.branding.primaryColor ?? ''}${t.branding.logoSha256 ?? ''}`} tenant={t} canEdit={canEdit} changing={changing} />

      <section className="pc-section" aria-labelledby="t-keys">
        <h2 id="t-keys" className="pc-section__title">
          Data keys
        </h2>
        <p className="pc-section__lead">Which keys protect this institution’s data. The keys themselves never leave Vault.</p>
        {t.keys.length === 0 ? (
          <p className="pc-empty">No data key yet.</p>
        ) : (
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Retired or destroyed</th>
              </tr>
            </thead>
            <tbody>
              {t.keys.map((k) => (
                <tr key={k.version}>
                  <td className="pc-table__strong">Version {k.version}</td>
                  <td data-label="Status">{k.status === 'ACTIVE' ? 'In use' : k.status === 'RETIRED' ? 'Retired' : 'Destroyed'}</td>
                  <td data-label="Created">{when(k.createdAt)}</td>
                  <td data-label="Retired or destroyed">{k.destroyedAt ? when(k.destroyedAt) : k.retiredAt ? when(k.retiredAt) : 'Not yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
