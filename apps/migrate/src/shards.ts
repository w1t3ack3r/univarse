// Spec 0039 Q8, Q9 (S8 PR A): the tenant migrations, run per shard and recorded. Every ACTIVE, MAINTENANCE and READY
// shard in turn (pools first, then by name): its migrator URL from the environment (Q4), `prisma migrate deploy`, the
// migrations it applied (read before and after), then rls:check on it. A failure records its fixed code, puts the
// shard in MAINTENANCE and goes on to the next; a success returns a shard in maintenance to ACTIVE, or to READY when
// it's a dedicated database with no institution. The steps are injected so the order and the stops are unit-tested;
// main.ts wires the real ones. Nothing logged carries a URL or a value: shard names, counts and codes only.

export type ShardStatus = 'READY' | 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';
export type RunErrorCode = 'unreachable' | 'no_credentials' | 'migrate_failed' | 'rls_failed' | 'unexpected';

export interface ShardToMigrate {
  readonly id: string;
  readonly name: string;
  readonly kind: 'POOL' | 'DEDICATED';
  readonly database: string;
  readonly status: ShardStatus;
  readonly hasTenant: boolean;
}

export type RunOutcome =
  | { readonly status: 'SUCCEEDED'; readonly applied: number; readonly lastMigration: string | null }
  | { readonly status: 'FAILED'; readonly code: RunErrorCode; readonly applied: number | null; readonly lastMigration: string | null };

export interface ShardSteps {
  /** ACTIVE, MAINTENANCE and READY shards, pools first, then by name. */
  listShards(): Promise<readonly ShardToMigrate[]>;
  /** The shard's migrator URL, or null when the environment has none for it (Q4). */
  migratorUrl(shard: ShardToMigrate): string | null;
  startRun(shard: ShardToMigrate): Promise<string>;
  finishRun(runId: string, outcome: RunOutcome): Promise<void>;
  /** The migrations applied on that database (`_prisma_migrations`), or 'unreachable'. */
  applied(url: string): Promise<readonly string[] | 'unreachable'>;
  /** `prisma migrate deploy` on that database; rejects on failure. */
  migrate(url: string): Promise<void>;
  /** rls:check on that database: its problems, none when isolated. */
  rlsCheck(url: string): Promise<readonly string[]>;
  setStatus(shardId: string, status: ShardStatus): Promise<void>;
  log(line: string): void;
}

export interface ShardsResult {
  readonly migrated: readonly string[];
  readonly failed: readonly { readonly name: string; readonly code: RunErrorCode }[];
}

/** Q9: where a shard goes after a successful run. */
export function statusAfterSuccess(s: Pick<ShardToMigrate, 'kind' | 'status' | 'hasTenant'>): ShardStatus {
  if (s.status !== 'MAINTENANCE') return s.status;
  return s.kind === 'DEDICATED' && !s.hasTenant ? 'READY' : 'ACTIVE';
}

/** The migrations newly applied: the names in `after` that `before` didn't have, in order. */
export function newlyApplied(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return after.filter((m) => !had.has(m));
}

async function migrateOne(shard: ShardToMigrate, steps: ShardSteps): Promise<RunOutcome> {
  const url = steps.migratorUrl(shard);
  if (!url) return { status: 'FAILED', code: 'no_credentials', applied: null, lastMigration: null };
  const before = await steps.applied(url);
  if (before === 'unreachable') return { status: 'FAILED', code: 'unreachable', applied: null, lastMigration: null };
  let migrateFailed = false;
  try {
    await steps.migrate(url);
  } catch {
    migrateFailed = true;
  }
  const after = await steps.applied(url);
  const done = after === 'unreachable' ? [] : newlyApplied(before, after);
  const applied = after === 'unreachable' ? null : done.length;
  const lastMigration = done.at(-1) ?? null;
  if (migrateFailed) return { status: 'FAILED', code: 'migrate_failed', applied, lastMigration };
  if (after === 'unreachable') return { status: 'FAILED', code: 'unreachable', applied: null, lastMigration: null };
  const problems = await steps.rlsCheck(url);
  if (problems.length > 0) return { status: 'FAILED', code: 'rls_failed', applied, lastMigration };
  return { status: 'SUCCEEDED', applied: done.length, lastMigration };
}

/** Q9: every shard, each recorded; one shard's failure never stops the next. */
export async function migrateShards(steps: ShardSteps): Promise<ShardsResult> {
  const shards = await steps.listShards();
  const migrated: string[] = [];
  const failed: { name: string; code: RunErrorCode }[] = [];
  for (const shard of shards) {
    steps.log(`[migrate] shard ${shard.name} (${shard.database}, ${shard.status})`);
    const runId = await steps.startRun(shard);
    let outcome: RunOutcome;
    try {
      outcome = await migrateOne(shard, steps);
    } catch {
      outcome = { status: 'FAILED', code: 'unexpected', applied: null, lastMigration: null };
    }
    await steps.finishRun(runId, outcome);
    if (outcome.status === 'SUCCEEDED') {
      const next = statusAfterSuccess(shard);
      if (next !== shard.status) await steps.setStatus(shard.id, next);
      migrated.push(shard.name);
      steps.log(`[migrate] shard ${shard.name}: ${String(outcome.applied)} migration(s) applied, rls:check passed${next !== shard.status ? `; back to ${next}` : ''}`);
    } else {
      if (shard.status !== 'MAINTENANCE') await steps.setStatus(shard.id, 'MAINTENANCE');
      failed.push({ name: shard.name, code: outcome.code });
      steps.log(`[migrate] shard ${shard.name}: FAILED (${outcome.code}); in maintenance, its institutions answer 503 until a run succeeds`);
    }
  }
  return { migrated, failed };
}
