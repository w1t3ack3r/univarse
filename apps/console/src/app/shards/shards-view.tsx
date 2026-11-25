'use client';

import type { PlatformShards } from '@univarse/contracts';
import { AlertCircle, Check, Notice } from '@univarse/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '../../components/console-shell';
import { NothingHere } from '../../components/nothing-here';
import { api, asApiError, type ApiError } from '../../lib/api';
import { when } from '../../lib/device';
import { healthText, runText, SHARD_KIND, SHARD_STATUS, warnsAbout, warningText } from '../../lib/shards';

type Server = PlatformShards['servers'][number];
type Shard = PlatformShards['shards'][number];

/**
 * Spec 0039 Q12: where institutions' data lives. What needs attention first, then each database server's connection
 * budget, then every shard with its institutions, its last migration and its health. Reading only: making, migrating
 * and retiring shards is the owner's command on the host. No connection string is ever shown.
 */
export function ShardsView() {
  const me = useMe();
  const [data, setData] = useState<PlatformShards | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const canRead = me.permissions.includes('platform.shard.read');

  useEffect(() => {
    if (!canRead) return;
    api<PlatformShards>('GET', '/shards')
      .then(setData)
      .catch((err: unknown) => setError(asApiError(err)));
  }, [canRead]);

  if (!canRead) return <NothingHere />;

  return (
    <section className="pc-section" aria-labelledby="shards-title">
      <div className="pc-section__head">
        <div>
          <h1 id="shards-title" className="pc-section__title">
            Shards
          </h1>
          <p className="pc-section__lead">
            Where institutions’ data lives. Shards are made, migrated and retired on the host with <code className="pc-code">pnpm stack:shards</code>.
          </p>
        </div>
      </div>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      {data === null ? (
        error ? null : <div className="pc-skeleton pc-skeleton--body" aria-hidden="true" />
      ) : (
        <>
          <Attention data={data} />
          {data.servers.map((s) => (
            <Budget key={s.id} server={s} />
          ))}
          <ShardTable data={data} />
        </>
      )}
    </section>
  );
}

function Attention({ data }: { data: PlatformShards }) {
  return (
    <div className="pc-approvals__group" role="group" aria-labelledby="shards-attention">
      <h2 id="shards-attention" className="pc-subhead">
        Needs attention
        {data.warnings.length ? <span className="pc-count">{data.warnings.length}</span> : null}
      </h2>
      {data.warnings.length === 0 ? (
        <div className="pc-empty pc-inbox__clear">
          <span className="uv-icon-tile">
            <Check />
          </span>
          <p>
            Every shard is answering, and {data.ready === 1 ? '1 dedicated database is' : `${String(data.ready)} dedicated databases are`} ready.
          </p>
        </div>
      ) : (
        <ul className="pc-list">
          {data.warnings.map((w, i) => {
            const t = warningText(w);
            return (
              <li key={`${w.type}-${'shard' in w ? w.shard : String(i)}`}>
                <div className="pc-list__row">
                  <span className="uv-icon-tile">
                    <AlertCircle />
                  </span>
                  <span className="pc-list__text">
                    <span className="pc-list__title">{t.title}</span>
                    <span className="pc-list__meta">{t.todo}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A server's connections as one measured bar; the sentence beside it says everything the bar shows. */
function Budget({ server: s }: { server: Server }) {
  const total = Math.max(s.maxConnections, 1);
  const pct = (n: number) => `${String(Math.max(0, Math.min(100, (n / total) * 100)))}%`;
  const id = `server-${s.id}`;
  return (
    <div className="pc-budget" role="group" aria-labelledby={id}>
      <h2 id={id} className="pc-subhead">
        Server {s.name} <span className="pc-note">({s.region})</span>
      </h2>
      <div className="pc-budget__bar" aria-hidden="true">
        <span className="pc-budget__seg pc-budget__seg--reserved" style={{ width: pct(s.reservedConnections) }} />
        <span className="pc-budget__seg pc-budget__seg--platform" style={{ width: pct(s.platformPools) }} />
        <span className="pc-budget__seg pc-budget__seg--shards" style={{ width: pct(s.shardPools) }} />
      </div>
      <dl className="pc-budget__legend">
        <div>
          <dt>
            <span className="pc-budget__key pc-budget__seg--reserved" aria-hidden="true" />
            Reserved
          </dt>
          <dd>{s.reservedConnections}</dd>
        </div>
        <div>
          <dt>
            <span className="pc-budget__key pc-budget__seg--platform" aria-hidden="true" />
            Platform
          </dt>
          <dd>{s.platformPools}</dd>
        </div>
        <div>
          <dt>
            <span className="pc-budget__key pc-budget__seg--shards" aria-hidden="true" />
            Shards
          </dt>
          <dd>{s.shardPools}</dd>
        </div>
        <div>
          <dt>
            <span className="pc-budget__key pc-budget__key--left" aria-hidden="true" />
            Left
          </dt>
          <dd>{Math.max(s.left, 0)}</dd>
        </div>
      </dl>
      <p className="pc-note">
        {s.maxConnections} connections in all. Room for {s.dedicatedRoom === 1 ? '1 more dedicated database' : `${String(s.dedicatedRoom)} more dedicated databases`}.
      </p>
    </div>
  );
}

function ShardTable({ data }: { data: PlatformShards }) {
  return (
    <div className="pc-approvals__group" role="group" aria-labelledby="shards-list">
      <h2 id="shards-list" className="pc-subhead">
        Every shard <span className="pc-count">{data.shards.length}</span>
      </h2>
      <table className="pc-table pc-shards">
        <thead>
          <tr>
            <th scope="col">Shard</th>
            <th scope="col">Status</th>
            <th scope="col">Institutions</th>
            <th scope="col">Last migration</th>
            <th scope="col">Health</th>
          </tr>
        </thead>
        <tbody>
          {data.shards.map((s) => (
            <Row key={s.id} shard={s} stale={warnsAbout(data.warnings, s.name, 'unchecked')} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ shard: s, stale }: { shard: Shard; stale: boolean }) {
  const status = SHARD_STATUS[s.status];
  const health = s.status === 'RETIRED' ? { text: 'Not checked: retired', tone: 'pc-status--none' } : healthText(s.health, stale);
  return (
    <tr>
      <td>
        <span className="pc-table__strong">{s.name}</span>
        <span className="pc-note pc-shard__about">
          {SHARD_KIND[s.kind]} on {s.server}, <span className="pc-table__mono">{s.database}</span>
        </span>
      </td>
      <td data-label="Status">
        <span className={`pc-status ${status.tone}`}>{status.label}</span>
        <span className="pc-note pc-shard__about">since {when(s.statusChangedAt)}</span>
      </td>
      <td data-label="Institutions">
        <Institutions shard={s} />
      </td>
      <td data-label="Last migration">{runText(s.lastRun)}</td>
      <td data-label="Health">
        <span className={`pc-status ${health.tone}`}>{health.text}</span>
      </td>
    </tr>
  );
}

function Institutions({ shard: s }: { shard: Shard }) {
  if (s.kind === 'DEDICATED') {
    if (s.institution)
      return (
        <Link className="uv-link" href={`/institutions/${s.institution.id}`}>
          {s.institution.name ?? s.institution.slug ?? 'Its institution'}
        </Link>
      );
    return <>{s.status === 'READY' ? 'Waiting for one' : 'None'}</>;
  }
  return (
    <>
      {s.institutions} of {s.capacity}
    </>
  );
}
