// Spec 0039 Q12: what staff read about shards instead of their machine names: a status, a migration's or a health
// check's fixed code, and each warning with what to do about it.
import type { PlatformShards, PlatformShardWarning } from '@univarse/contracts';
import { when } from './device';

type Shard = PlatformShards['shards'][number];

export const SHARD_KIND: Readonly<Record<Shard['kind'], string>> = { POOL: 'Pool', DEDICATED: 'Dedicated database' };

export const SHARD_STATUS: Readonly<Record<Shard['status'], { label: string; tone: string }>> = {
  ACTIVE: { label: 'In service', tone: 'pc-status--on' },
  READY: { label: 'Ready', tone: 'pc-status--on' },
  MAINTENANCE: { label: 'In maintenance', tone: 'pc-status--bad' },
  RETIRED: { label: 'Retired', tone: 'pc-status--none' },
};

/** Spec 0039 Q8: a failed migration run's code. */
export const RUN_ERROR: Readonly<Record<NonNullable<NonNullable<Shard['lastRun']>['errorCode']>, string>> = {
  migrate_failed: 'a migration failed part-way',
  rls_failed: 'the isolation check failed after migrating',
  unreachable: 'the migrate job couldn’t reach the database',
  no_credentials: 'the deploy has no connection settings for it',
  unexpected: 'something unexpected stopped the run',
};

/** Spec 0039 Q11: a failed health check's code. */
export const HEALTH_ERROR: Readonly<Record<NonNullable<NonNullable<Shard['health']>['errorCode']>, string>> = {
  unreachable: 'didn’t answer',
  timeout: 'took longer than 5 seconds to answer',
  no_credentials: 'has no connection settings in the deploy',
  unexpected: 'failed in an unexpected way',
};

/** A shard's last migration run, in a few words. */
export function runText(run: Shard['lastRun']): string {
  if (!run) return 'No migration run recorded';
  if (run.status === 'RUNNING') return `Migrating since ${when(run.startedAt)}`;
  if (run.status === 'FAILED') return `Failed ${when(run.finishedAt)}: ${run.errorCode ? RUN_ERROR[run.errorCode] : 'no code recorded'}`;
  return `Migrated ${when(run.finishedAt)}${run.applied ? `, ${String(run.applied)} applied` : ''}`;
}

/** A shard's last health check, in a few words; `stale` when the worker hasn't checked it lately. */
export function healthText(h: Shard['health'], stale: boolean): { text: string; tone: string } {
  if (!h) return { text: 'Not checked yet', tone: 'pc-status--wait' };
  if (stale) return { text: `Last checked ${when(h.checkedAt)}`, tone: 'pc-status--wait' };
  if (h.ok) return { text: `Answering, ${String(h.latencyMs ?? 0)} ms`, tone: 'pc-status--on' };
  return { text: `Not answering: it ${h.errorCode ? HEALTH_ERROR[h.errorCode] : 'failed'}`, tone: 'pc-status--bad' };
}

/** Each warning as the page says it: what is wrong, and what to do. */
export function warningText(w: PlatformShardWarning): { title: string; todo: string } {
  switch (w.type) {
    case 'maintenance':
      return {
        title: `${w.shard} is in maintenance: ${w.errorCode ? RUN_ERROR[w.errorCode] : 'its last migration failed'}`,
        todo: `Since ${when(w.since)}, its institutions see “closed for maintenance”. Settle the failed migration on the host, then run pnpm stack:shards migrate ${w.shard}.`,
      };
    case 'unreachable':
      return {
        title: `${w.shard} isn’t answering: it ${w.errorCode ? HEALTH_ERROR[w.errorCode] : 'failed its check'}`,
        todo: `${w.lastSuccessAt ? `It last answered ${when(w.lastSuccessAt)}.` : 'It has never answered.'} Check its database server is running.`,
      };
    case 'unchecked':
      return {
        title: `${w.shard} hasn’t been checked ${w.checkedAt ? `since ${when(w.checkedAt)}` : 'yet'}`,
        todo: 'The worker checks every shard each minute. Check the worker is running.',
      };
    case 'ready_low':
      return {
        title: `${w.ready === 0 ? 'No dedicated database is' : w.ready === 1 ? 'Only 1 dedicated database is' : `Only ${String(w.ready)} dedicated databases are`} ready; keep ${String(w.minimum)}`,
        todo: `A dedicated institution can’t be created without one. Run pnpm stack:shards ready --count ${String(w.minimum - w.ready)} on the host.`,
      };
    case 'pool_nearly_full':
      return {
        title: `${w.shard} holds ${String(w.held)} of its ${String(w.capacity)} institutions`,
        todo: 'Add a pool before it fills: when every pool is full, new pooled institutions are refused.',
      };
  }
}

/** Whether a shard's warnings include one about it, so its row can say so too. */
export const warnsAbout = (warnings: readonly PlatformShardWarning[], shard: string, type: PlatformShardWarning['type']) => warnings.some((w) => w.type === type && 'shard' in w && w.shard === shard);
