'use client';

import type { PlatformPurgeView } from '@univarse/contracts';
import { Button, Check, ChevronDown, Download, Notice } from '@univarse/ui';
import { CopyButton } from '@univarse/ui/client';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api, asApiError, field, type ApiError } from '../../../lib/api';
import { when } from '../../../lib/device';
import type { Changing, Tenant } from './institution-view';

const STEPS: readonly { key: keyof NonNullable<PlatformPurgeView['run']>; label: string }[] = [
  { key: 'keysDestroyedAt', label: 'Its data keys destroyed (the shred ledger records it)' },
  { key: 'rowsDeletedAt', label: 'Its records deleted, its audit trail included' },
  { key: 'objectsDeletedAt', label: 'Its files deleted from storage' },
  { key: 'platformDeletedAt', label: 'Its platform records deleted; it becomes a closed record' },
  { key: 'certificateAt', label: 'The certificate of deletion written' },
];

/** The host command, as the owner types it: never run from here (the console holds no tenant credential, A2). */
const command = (slug: string, solo = false) => (solo ? `pnpm stack:purge ${slug} --solo --reason "why one person"` : `pnpm stack:purge ${slug}`);

function Command({ text }: { text: string }) {
  return (
    <div className="pc-command">
      <code className="pc-command__text">{text}</code>
      <CopyButton text={text} label="Copy" />
    </div>
  );
}

/**
 * Spec 0038 Q9–Q13, Q15: an archived institution's purge, as the console sees it. Asking for it (two people); waiting for
 * the second; the authorisation and the host command that uses it; the run's steps; and once done, the certificate.
 * Nothing here deletes anything: the purge runs on the host (`pnpm stack:purge`).
 */
export function PurgeSection({ tenant, canOffboard, changing }: { tenant: Tenant; canOffboard: boolean; changing: Changing }) {
  const p = tenant.purge;
  if (!p) return null;
  if (p.run?.certificateAt) return <Purged tenant={tenant} run={p.run} />;
  return (
    <div className="pc-notice-record pc-purge">
      <h3 className="pc-subhead">Deleting its data</h3>
      {p.run ? (
        <Running tenant={tenant} run={p.run} />
      ) : p.request?.status === 'EXECUTED' && p.request.authorisationExpiresAt && new Date(p.request.authorisationExpiresAt) > new Date() ? (
        <>
          <p className="pc-note">
            Authorised: asked by {p.request.requestedBy.name ?? 'a former member'}, approved by {p.request.decidedBy?.name ?? 'a former member'} {when(p.request.authorisedAt)}. The owner runs it on
            the host before {when(p.request.authorisationExpiresAt)}:
          </p>
          <Command text={command(tenant.slug)} />
        </>
      ) : p.request?.status === 'PENDING' ? (
        <p className="pc-note">
          Waiting for a second person: {p.request.requestedBy.name ?? 'a former member'} asked.{' '}
          <Link className="uv-link" href={`/approvals/${p.request.approvalId}`}>
            Open the request
          </Link>
        </p>
      ) : canOffboard && tenant.status === 'ARCHIVED' ? (
        p.secondPersonAvailable ? (
          <AskForm tenant={tenant} changing={changing} />
        ) : (
          <>
            <p className="pc-note">Nobody else can approve a purge yet. Until there is a second person, the owner can run it alone on the host, and it’s recorded as one person’s:</p>
            <Command text={command(tenant.slug, true)} />
          </>
        )
      ) : (
        <p className="pc-note">Its data is still here, unreadable to anyone outside it. Deleting it takes two people.</p>
      )}
    </div>
  );
}

function AskForm({ tenant, changing }: { tenant: Tenant; changing: Changing }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ask = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = field(new FormData(e.currentTarget), 'reason');
    setBusy(true);
    setError(null);
    stepUp(async () => {
      await api('POST', '/approvals', { kind: 'tenant.purge', payload: { tenantId: tenant.id, slug: tenant.slug }, reason });
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(`Asked for ${tenant.shortName}’s purge. A second member decides it in their inbox.`);
      })
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(false));
  };
  return (
    <details className="pc-disclosure">
      <summary className="uv-link">
        Ask for its purge
        <ChevronDown size={18} />
      </summary>
      <form method="post" className="pc-form pc-form--narrow pc-disclosure__body" onSubmit={ask} noValidate>
        <Notice tone="info">
          A second member approves it. The owner then runs it on the host within 7 days: its keys are destroyed first, then its records, files and platform records are deleted, and a
          certificate of deletion is written. It can’t be undone. Backups taken before it keep its data, unreadable, until they expire.
        </Notice>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <div className="uv-field">
          <label className="uv-label" htmlFor="purge-reason">
            Why now?
          </label>
          <textarea id="purge-reason" name="reason" className="uv-input pc-textarea" minLength={3} maxLength={500} required rows={3} />
        </div>
        <div className="pc-row-actions pc-row-actions--start">
          <Button type="submit" variant="quiet" className="pc-danger" pending={busy}>
            Ask for {tenant.shortName}’s purge
          </Button>
        </div>
      </form>
    </details>
  );
}

function Steps({ run }: { run: NonNullable<PlatformPurgeView['run']> }) {
  return (
    <ol className="pc-steps">
      {STEPS.map((s, i) => {
        const at = run[s.key] as string | null;
        return (
          <li key={s.key} className={at ? 'pc-steps__item pc-steps__item--done' : 'pc-steps__item'}>
            <span className="pc-steps__mark" aria-hidden="true">
              {at ? <Check size={16} /> : i + 1}
            </span>
            <span className="pc-steps__label">{s.label}</span>
            <span className="pc-steps__when">{at ? when(at) : 'Not yet'}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Running({ tenant, run }: { tenant: Tenant; run: NonNullable<PlatformPurgeView['run']> }) {
  return (
    <>
      <p className="pc-note">
        Begun {when(run.startedAt)}
        {run.solo ? ', by one person (nobody else could approve it)' : ''}. It stopped before the end; running the command again finishes it from where it stopped:
      </p>
      <Steps run={run} />
      <Command text={command(tenant.slug)} />
    </>
  );
}

/** Q12: the certificate, to read here and to download for the institution. */
function Purged({ tenant, run }: { tenant: Tenant; run: NonNullable<PlatformPurgeView['run']> }) {
  const c = (run.certificate ?? {}) as { lastBackupGoneBy?: string | null; authority?: { askedBy?: string | null; approvedBy?: string | null; reason?: string | null } };
  const download = () => {
    const blob = new Blob([`${JSON.stringify(run.certificate, null, 2)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tenant.slug}-certificate-of-deletion.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section className="pc-section pc-purged" aria-labelledby="t-purged">
      <h2 id="t-purged" className="pc-section__title">
        Purged
      </h2>
      <p className="pc-section__lead">
        {tenant.legalName}’s data was deleted {when(run.certificateAt)}: its keys destroyed, then its records, files and platform records. Its address stays reserved for good.
      </p>
      <dl className="pc-facts pc-facts--card">
        <div>
          <dt>Authority</dt>
          <dd>{run.solo ? `One person, as nobody else could approve it: ${run.reason ?? ''}` : `Asked by ${c.authority?.askedBy ?? 'a former member'}, approved by ${c.authority?.approvedBy ?? 'a former member'}`}</dd>
        </div>
        <div>
          <dt>Backups</dt>
          <dd>{c.lastBackupGoneBy ? `Sets taken before it still hold its data, unreadable without its keys, until they’re deleted by ${c.lastBackupGoneBy}.` : 'No backup taken before it holds its data.'}</dd>
        </div>
        <div>
          <dt>Certificate</dt>
          <dd>
            <span className="pc-hash">SHA-256 {run.certificateSha256}</span>
          </dd>
        </div>
      </dl>
      <Steps run={run} />
      <div className="pc-row-actions pc-row-actions--start">
        <Button type="button" variant="quiet" onClick={download}>
          <Download />
          Download the certificate
        </Button>
      </div>
    </section>
  );
}
