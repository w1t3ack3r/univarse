// Spec 0038 Q9–Q14 (A7, A12, T36): an archived institution's purge, the database and storage half, as the `purge` job
// from the deployed API image (Q-C2). The host's `pnpm stack:purge` drives it step by step; the keys step is the
// key-destruction protocol's own (spec 0020), run by the host between `begin` and `rows`. Every step is idempotent and
// recorded once, in order, on `platform_tenant_purge` (a check and a trigger hold the order for every role), so a purge
// stopped anywhere resumes from the step it stopped at. It runs as the migrator, the tables' owner: the app's role can't
// delete an audit chain (invariant 5), and the purge is its one exception (Q14). Each tenant table is deleted under the
// institution's own RLS context. Everything printed is ids, slugs, counts and times: never a value or a secret.
//
//   purge check <slug> [--solo --reason "…"]        what's authorised and done; exit 0 if it may go on, 3 if refused
//   purge begin <slug> [--solo --reason "…"]        records the purge (idempotent), using the authorisation once
//   purge keys-done <slug> --op <uuid>              records step 1, after the protocol committed (all keys destroyed)
//   purge rows <slug>                               step 2: every tenant table's rows, the counts kept
//   purge objects <slug>                            step 3: storage under tenants/{id}/, every bucket
//   purge platform <slug>                           step 4: the platform rows (Q-C5), then PURGED
//   purge facts <slug>                              everything the certificate states (the host writes it)
//   purge finish <slug> --sha256 <hex>              step 5: the certificate (JSON on stdin), its hash checked
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { writePlatformAudit } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, shardUrl, withTenantTx, type PlatformClient, type PlatformModels, type TenantShardClient, type TenantTx } from '@univarse/db';
import type { PlatformTx } from '../platform/identity/types.js';
import {
  authorisationUsable,
  isDrillSlug,
  nextPurgeStep,
  purgeAuthorisationExpiry,
  purgeReasonProblem,
  soloPurgeAllowed,
  type PurgeProgress,
  type PurgeStep,
} from '@univarse/domain';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Every tenant table, children before parents; a table missing from here stops the rows step (never a row left). */
export const PURGE_TABLE_ORDER = [
  'data_export',
  'notice_dismissal',
  'contact_change',
  'mfa_challenge',
  'mfa_factor',
  'recovery_code',
  'one_time_token',
  'session',
  'role_assignment',
  'role',
  'audit_event',
  'outbox_event',
  'setting',
  'file_object',
  'sequence',
  'user_account',
  'org_unit',
] as const;

/** Each table's delete, typed (no SQL text is built from a name). org_unit is deleted leaves first, below. */
type Deleter = (tx: TenantTx, tenantId: string) => Promise<{ count: number }>;
const DELETERS: Readonly<Record<Exclude<(typeof PURGE_TABLE_ORDER)[number], 'org_unit'>, Deleter>> = {
  data_export: (tx, tenantId) => tx.dataExport.deleteMany({ where: { tenantId } }),
  notice_dismissal: (tx, tenantId) => tx.noticeDismissal.deleteMany({ where: { tenantId } }),
  contact_change: (tx, tenantId) => tx.contactChange.deleteMany({ where: { tenantId } }),
  mfa_challenge: (tx, tenantId) => tx.mfaChallenge.deleteMany({ where: { tenantId } }),
  mfa_factor: (tx, tenantId) => tx.mfaFactor.deleteMany({ where: { tenantId } }),
  recovery_code: (tx, tenantId) => tx.recoveryCode.deleteMany({ where: { tenantId } }),
  one_time_token: (tx, tenantId) => tx.oneTimeToken.deleteMany({ where: { tenantId } }),
  session: (tx, tenantId) => tx.session.deleteMany({ where: { tenantId } }),
  role_assignment: (tx, tenantId) => tx.roleAssignment.deleteMany({ where: { tenantId } }),
  role: (tx, tenantId) => tx.role.deleteMany({ where: { tenantId } }),
  // Q14: the institution's audit chain goes with its data; the institution received it in its export.
  audit_event: (tx, tenantId) => tx.auditEvent.deleteMany({ where: { tenantId } }),
  outbox_event: (tx, tenantId) => tx.outboxEvent.deleteMany({ where: { tenantId } }),
  setting: (tx, tenantId) => tx.setting.deleteMany({ where: { tenantId } }),
  file_object: (tx, tenantId) => tx.fileObject.deleteMany({ where: { tenantId } }),
  sequence: (tx, tenantId) => tx.sequence.deleteMany({ where: { tenantId } }),
  user_account: (tx, tenantId) => tx.userAccount.deleteMany({ where: { tenantId } }),
};

/** Q-C5: the platform tables whose rows of the institution go, in an order its foreign keys allow. */
export const PURGED_PLATFORM_TABLES = [
  'platform_notice_delivery',
  'platform_incident_tenant',
  'platform_tenant_suspension',
  'platform_tenant_export',
  'provisioning_step',
  'provisioning_job',
  'tenant_onboarding',
  'tenant_domain',
  'tenant_product',
  'tenant_branding',
  'tenant_regulatory_profile',
] as const;

export type Refusal =
  | 'no_tenant'
  | 'drill_tenant'
  | 'not_archived'
  | 'no_authorisation'
  | 'authorisation_expired'
  | 'authorisation_used'
  | 'solo_not_allowed'
  | 'reason'
  | 'solo_and_authorised'
  | 'step_out_of_order'
  | 'keys_not_destroyed'
  | 'unknown_tenant_table'
  | 'no_shard_url'
  | 'certificate_hash';

export class PurgeRefused extends Error {
  constructor(readonly why: Refusal) {
    super(why);
    this.name = 'PurgeRefused';
  }
}

export interface PurgeOptions {
  readonly solo?: boolean;
  readonly reason?: string;
}

type Tenant = { id: string; slug: string; legalName: string; type: string; status: string; shardId: string };
/** The client or one of its transactions: every read and step below runs on either. */
type Db = PlatformClient | PlatformTx;

const progressOf = (p: { keysDestroyedAt: Date | null; rowsDeletedAt: Date | null; objectsDeletedAt: Date | null; platformDeletedAt: Date | null; certificateAt: Date | null } | null): PurgeProgress =>
  p ?? { keysDestroyedAt: null, rowsDeletedAt: null, objectsDeletedAt: null, platformDeletedAt: null, certificateAt: null };

async function tenantOf(platform: Db, slug: string): Promise<Tenant> {
  const t = await platform.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, legalName: true, type: true, status: true, shardId: true } });
  if (!t) throw new PurgeRefused('no_tenant');
  if (isDrillSlug(t.slug)) throw new PurgeRefused('drill_tenant');
  return t;
}

/** Q-C1: the newest executed `tenant.purge` approval naming this institution (by id and slug), with its use. */
async function authorisationFor(platform: Db, t: Tenant) {
  const executed = await platform.platformApproval.findMany({
    where: { kind: 'tenant.purge', status: 'EXECUTED' },
    orderBy: { executedAt: 'desc' },
    select: { id: true, payload: true, executedAt: true, requestedBy: true, decidedBy: true, purge: { select: { id: true } } },
  });
  const a = executed.find((e) => {
    const p = e.payload as Record<string, unknown>;
    return p.tenantId === t.id && p.slug === t.slug;
  });
  return a ?? null;
}

async function staff(platform: Db) {
  const users = await platform.platformUser.findMany({ select: { role: true, isActive: true, mfaFactors: { where: { confirmedAt: { not: null }, revokedAt: null }, select: { id: true } } } });
  return users.map((u) => ({ role: u.role, isActive: u.isActive, mfaEnrolled: u.mfaFactors.length > 0 }));
}

/**
 * What may happen now. A purge already begun resumes whatever its authority (it was checked when it began); a new one
 * needs an archived institution and either a usable authorisation or, solo, nobody else who could approve (Q11).
 */
export async function check(platform: Db, slug: string, opts: PurgeOptions = {}, now = new Date()) {
  const t = await tenantOf(platform, slug);
  const run = await platform.platformTenantPurge.findUnique({ where: { tenantId: t.id } });
  if (run) {
    if (opts.solo && !run.solo) throw new PurgeRefused('solo_and_authorised');
    return { tenant: t, run, resuming: true as const, next: nextPurgeStep(progressOf(run)) };
  }
  if (t.status !== 'ARCHIVED') throw new PurgeRefused('not_archived');
  const a = await authorisationFor(platform, t);
  if (opts.solo) {
    if (purgeReasonProblem(opts.reason)) throw new PurgeRefused('reason');
    if (a && a.executedAt && authorisationUsable({ executedAt: a.executedAt, usedBy: a.purge?.id ?? null }, now)) throw new PurgeRefused('solo_and_authorised');
    if (!soloPurgeAllowed(await staff(platform))) throw new PurgeRefused('solo_not_allowed');
    return { tenant: t, run: null, resuming: false as const, next: 'keys' as PurgeStep, authorisation: null };
  }
  if (!a || !a.executedAt) throw new PurgeRefused('no_authorisation');
  if (a.purge) throw new PurgeRefused('authorisation_used');
  if (!authorisationUsable({ executedAt: a.executedAt, usedBy: null }, now)) throw new PurgeRefused('authorisation_expired');
  return { tenant: t, run: null, resuming: false as const, next: 'keys' as PurgeStep, authorisation: { id: a.id, executedAt: a.executedAt, expiresAt: purgeAuthorisationExpiry(a.executedAt) } };
}

/** Records the purge (idempotent): the authorisation is used here, once, by the unique index on its id. */
export async function begin(platform: PlatformClient, slug: string, opts: PurgeOptions = {}, now = new Date()) {
  return platform.$transaction(async (tx) => {
    const t0 = await tenantOf(tx, slug);
    await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${t0.id}::uuid FOR UPDATE`;
    const c = await check(tx, slug, opts, now);
    if (c.resuming) return c.run;
    const run = await tx.platformTenantPurge.create({
      data: { tenantId: c.tenant.id, approvalId: c.authorisation?.id ?? null, solo: opts.solo === true, reason: opts.solo ? (opts.reason ?? '').trim() : null, startedAt: now },
    });
    // The reason is the owner's own words: on the row and the certificate, never the audit chain (as every note).
    await writePlatformAudit(tx, { actorId: null, tenantId: c.tenant.id, action: 'platform.tenant.purge_started', metadata: { purgeId: run.id, slug, solo: run.solo, approvalId: run.approvalId } });
    return run;
  });
}

/** Locks the institution's purge and checks `step` is the next one (Q-C3); returns the run and the tenant. */
async function stepStart(tx: Db, slug: string, step: PurgeStep) {
  const t = await tenantOf(tx, slug);
  await tx.$queryRaw`SELECT id FROM platform_tenant_purge WHERE tenant_id = ${t.id}::uuid FOR UPDATE`;
  const run = await tx.platformTenantPurge.findUnique({ where: { tenantId: t.id } });
  if (!run) throw new PurgeRefused('step_out_of_order');
  const next = nextPurgeStep(progressOf(run));
  if (next !== step) return { t, run, done: next === null || PURGE_ORDER.indexOf(next) > PURGE_ORDER.indexOf(step), outOfOrder: next !== null && PURGE_ORDER.indexOf(next) < PURGE_ORDER.indexOf(step) };
  return { t, run, done: false, outOfOrder: false };
}
const PURGE_ORDER: readonly PurgeStep[] = ['keys', 'rows', 'objects', 'platform', 'certificate'];

const audited = (tx: PlatformTx, tenantId: string, step: PurgeStep, detail: Record<string, unknown>) =>
  writePlatformAudit(tx, { actorId: null, tenantId, action: 'platform.tenant.purge_step', metadata: { step, ...detail } });

/** Step 1's record, after the protocol committed: only if every data key of the institution is destroyed. */
export async function keysDone(platform: PlatformClient, slug: string, op: string, now = new Date()) {
  return platform.$transaction(async (tx) => {
    const s = await stepStart(tx, slug, 'keys');
    if (s.outOfOrder) throw new PurgeRefused('step_out_of_order');
    if (s.done) return s.run;
    const live = await tx.tenantDataKey.count({ where: { tenantId: s.t.id, destroyedAt: null } });
    const any = await tx.tenantDataKey.count({ where: { tenantId: s.t.id } });
    if (live > 0 || any === 0) throw new PurgeRefused('keys_not_destroyed');
    const run = await tx.platformTenantPurge.update({ where: { id: s.run.id }, data: { keysOp: op, keysDestroyedAt: now, updatedAt: now } });
    await audited(tx, s.t.id, 'keys', { op });
    return run;
  });
}

/**
 * Step 2 (Q10.2, Q14): every tenant table's rows of the institution, children first, each table in its own transaction
 * under the institution's RLS context. A tenant table this list doesn't know stops the step before anything is deleted.
 */
/** Spec 0039 Q13: the migrator's client for a shard, by its id. */
export type MigratorShards = (shardId: string) => Promise<TenantShardClient>;

/**
 * Spec 0039 Q13: the institution's own shard, as the migrator: a pool's `…_MIGRATOR_URL`, or a dedicated database's
 * server template, both from the environment (T37), never from a row. One client per shard, closed by `close`.
 */
export function migratorShards(platform: PlatformClient, env: NodeJS.ProcessEnv): { of: MigratorShards; close: () => Promise<void> } {
  const clients = new Map<string, TenantShardClient>();
  return {
    of: async (shardId) => {
      const cached = clients.get(shardId);
      if (cached) return cached;
      const s = await platform.shard.findUniqueOrThrow({ where: { id: shardId }, select: { name: true, kind: true, secretRef: true, database: true, server: { select: { secretRef: true } } } });
      const r = shardUrl(s, 'migrator', env);
      if ('problem' in r) throw new PurgeRefused('no_shard_url');
      const client = createTenantShardClient(r.url);
      clients.set(shardId, client);
      return client;
    },
    close: async () => {
      await Promise.all([...clients.values()].map((c) => c.$disconnect()));
    },
  };
}

export async function rows(platform: PlatformClient, shards: MigratorShards, slug: string, now = new Date()) {
  const s = await platform.$transaction((tx) => stepStart(tx, slug, 'rows'));
  if (s.outOfOrder) throw new PurgeRefused('step_out_of_order');
  if (s.done) return s.run;
  const live = await platform.tenantDataKey.count({ where: { tenantId: s.t.id, destroyedAt: null } });
  if (live > 0) throw new PurgeRefused('keys_not_destroyed');
  // Spec 0039 Q13: wherever the institution lives, a pool or its own database; refused before anything is deleted.
  const shard = await shards(s.t.shardId);
  const tables = await shard.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'`;
  const known = new Set<string>(PURGE_TABLE_ORDER);
  if (tables.some((x) => !known.has(x.table_name))) throw new PurgeRefused('unknown_tenant_table');
  const counts: Record<string, number> = {};
  for (const table of PURGE_TABLE_ORDER) {
    counts[table] = await withTenantTx(
      shard,
      s.t.id,
      async (tx) => {
        if (table === 'org_unit') {
          // A unit's parent can't go before its children (RESTRICT): leaves first, until none is left.
          let n = 0;
          for (;;) {
            const k = await tx.$executeRaw`
              DELETE FROM org_unit o WHERE o.tenant_id = ${s.t.id}::uuid
                AND NOT EXISTS (SELECT 1 FROM org_unit c WHERE c.tenant_id = o.tenant_id AND c.parent_id = o.id)`;
            n += k;
            if (k === 0) break;
          }
          return n;
        }
        return (await DELETERS[table](tx, s.t.id)).count;
      },
      { timeoutMs: 300_000 },
    );
  }
  return platform.$transaction(async (tx) => {
    const again = await stepStart(tx, slug, 'rows');
    if (again.done) return again.run;
    const run = await tx.platformTenantPurge.update({ where: { id: again.run.id }, data: { rows: counts, rowsDeletedAt: now, updatedAt: now } });
    await audited(tx, s.t.id, 'rows', { rows: counts });
    return run;
  });
}

export interface Storage {
  readonly s3: S3Client;
  readonly buckets: readonly string[];
}

/** Step 3 (Q10.3): every object under `tenants/{tenantId}/` in every bucket, and any unfinished upload there. */
export async function objects(platform: PlatformClient, storage: Storage, slug: string, now = new Date()) {
  const s = await platform.$transaction((tx) => stepStart(tx, slug, 'objects'));
  if (s.outOfOrder) throw new PurgeRefused('step_out_of_order');
  if (s.done) return s.run;
  const prefix = `tenants/${s.t.id}/`;
  const counts: Record<string, number> = {};
  for (const Bucket of storage.buckets) {
    let n = 0;
    for (;;) {
      const page = await storage.s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: 1000 }));
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
      if (keys.length === 0) break;
      for (const Key of keys) await storage.s3.send(new DeleteObjectCommand({ Bucket, Key }));
      n += keys.length;
    }
    const uploads = await storage.s3.send(new ListMultipartUploadsCommand({ Bucket, Prefix: prefix })).catch(() => ({ Uploads: [] }));
    for (const u of uploads.Uploads ?? []) {
      if (u.Key?.startsWith(prefix) && u.UploadId) await storage.s3.send(new AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId }));
    }
    counts[Bucket] = n;
  }
  return platform.$transaction(async (tx) => {
    const again = await stepStart(tx, slug, 'objects');
    if (again.done) return again.run;
    const run = await tx.platformTenantPurge.update({ where: { id: again.run.id }, data: { objects: counts, objectsDeletedAt: now, updatedAt: now } });
    await audited(tx, s.t.id, 'objects', { objects: counts });
    return run;
  });
}

/** Step 4 (Q10.4, Q-C5, Q13): the institution's platform rows, then the tenant becomes its tombstone, `PURGED`. */
export async function platformRows(platform: PlatformClient, slug: string, now = new Date()) {
  return platform.$transaction(
    async (tx) => {
      const s = await stepStart(tx, slug, 'platform');
      if (s.outOfOrder) throw new PurgeRefused('step_out_of_order');
      if (s.done) return s.run;
      const id = s.t.id;
      const counts: Record<string, number> = {
        platform_notice_delivery: (await tx.platformNoticeDelivery.deleteMany({ where: { tenantId: id } })).count,
        platform_incident_tenant: (await tx.platformIncidentTenant.deleteMany({ where: { tenantId: id } })).count,
        platform_tenant_suspension: (await tx.platformTenantSuspension.deleteMany({ where: { tenantId: id } })).count,
        platform_tenant_export: (await tx.platformTenantExport.deleteMany({ where: { tenantId: id } })).count,
        provisioning_step: (await tx.provisioningStep.deleteMany({ where: { job: { tenantId: id } } })).count,
        provisioning_job: (await tx.provisioningJob.deleteMany({ where: { tenantId: id } })).count,
        tenant_onboarding: (await tx.tenantOnboarding.deleteMany({ where: { tenantId: id } })).count,
        tenant_domain: (await tx.tenantDomain.deleteMany({ where: { tenantId: id } })).count,
        tenant_product: (await tx.tenantProduct.deleteMany({ where: { tenantId: id } })).count,
        tenant_branding: (await tx.tenantBranding.deleteMany({ where: { tenantId: id } })).count,
        tenant_regulatory_profile: (await tx.tenantRegulatoryProfile.deleteMany({ where: { tenantId: id } })).count,
      };
      await tx.tenant.update({ where: { id }, data: { status: 'PURGED', purgedAt: now }, select: { id: true } });
      const run = await tx.platformTenantPurge.update({ where: { id: s.run.id }, data: { platformRows: counts, platformDeletedAt: now, updatedAt: now } });
      await audited(tx, id, 'platform', { platform: counts });
      return run;
    },
    { timeout: 60_000 },
  );
}

/** Everything the certificate states (Q12), from the records: never a value, an address or a secret. */
export async function facts(platform: PlatformClient, slug: string) {
  const t = await tenantOf(platform, slug);
  const run = await platform.platformTenantPurge.findUnique({
    where: { tenantId: t.id },
    include: { approval: { select: { id: true, executedAt: true, requester: { select: { displayName: true } }, decider: { select: { displayName: true } } } } },
  });
  if (!run) throw new PurgeRefused('step_out_of_order');
  return {
    institution: { id: t.id, slug: t.slug, legalName: t.legalName, type: t.type, status: t.status },
    authority: run.solo
      ? { solo: true, reason: run.reason }
      : { solo: false, approvalId: run.approval?.id ?? null, askedBy: run.approval?.requester.displayName ?? null, approvedBy: run.approval?.decider?.displayName ?? null, approvedAt: run.approval?.executedAt?.toISOString() ?? null },
    startedAt: run.startedAt.toISOString(),
    keys: { op: run.keysOp, destroyedAt: run.keysDestroyedAt?.toISOString() ?? null },
    rows: { deletedAt: run.rowsDeletedAt?.toISOString() ?? null, perTable: run.rows },
    objects: { deletedAt: run.objectsDeletedAt?.toISOString() ?? null, perBucket: run.objects },
    platform: { deletedAt: run.platformDeletedAt?.toISOString() ?? null, perTable: run.platformRows },
    certificate: run.certificateAt ? { at: run.certificateAt.toISOString(), sha256: run.certificateSha256 } : null,
  };
}

/** Step 5 (Q12): the certificate as the host wrote it, its SHA-256 checked, on the purge row and the tombstone. */
export async function finish(platform: PlatformClient, slug: string, certificateText: string, sha256: string, now = new Date()) {
  if (createHash('sha256').update(certificateText, 'utf8').digest('hex') !== sha256) throw new PurgeRefused('certificate_hash');
  // The host's JSON, stored as written (its hash, checked above, is over exactly this text).
  const certificate = JSON.parse(certificateText) as PlatformModels.Prisma.InputJsonObject;
  return platform.$transaction(async (tx) => {
    const s = await stepStart(tx, slug, 'certificate');
    if (s.outOfOrder) throw new PurgeRefused('step_out_of_order');
    if (s.done) return s.run;
    const run = await tx.platformTenantPurge.update({ where: { id: s.run.id }, data: { certificate: certificate, certificateSha256: sha256, certificateAt: now, updatedAt: now } });
    await tx.tenant.update({ where: { id: s.t.id }, data: { purgeCertificateSha256: sha256 }, select: { id: true } });
    await writePlatformAudit(tx, { actorId: null, tenantId: s.t.id, action: 'platform.tenant.purged', metadata: { purgeId: run.id, slug, solo: run.solo, certificateSha256: sha256 } });
    return run;
  });
}

function args(rest: readonly string[]): { slug: string; flags: Record<string, string>; solo: boolean } {
  const [slug, ...more] = rest;
  if (!slug || !/^[a-z0-9-]{3,63}$/.test(slug)) throw new Error('usage: purge <command> <slug> [--solo --reason "…"] [--op <uuid>] [--sha256 <hex>]');
  const flags: Record<string, string> = {};
  let solo = false;
  for (let i = 0; i < more.length; i++) {
    const name = more[i];
    if (name === '--solo') solo = true;
    else if (name === '--reason' || name === '--op' || name === '--sha256') flags[name.slice(2)] = more[++i] ?? '';
    else throw new Error(`unknown flag ${String(name)}`);
  }
  return { slug, flags, solo };
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

/** The job's entry: one command, its result as the last JSON line; exit 0 done, 3 refused, 1 failed. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const platform = createPlatformClient(env.PLATFORM_MIGRATOR_URL ?? '');
  const shards = migratorShards(platform, env);
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
    region: env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY ?? '', secretAccessKey: env['S3_SECRET_KEY'] ?? '' },
  });
  const buckets = [env.S3_QUARANTINE_BUCKET ?? 'uv-quarantine', env.S3_CLEAN_BUCKET ?? 'uv-clean', env.S3_EXPORTS_BUCKET ?? 'uv-exports'];
  const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)));
  try {
    const { slug, flags, solo } = args(rest);
    const opts: PurgeOptions = { solo, ...(flags.reason === undefined ? {} : { reason: flags.reason }) };
    switch (command) {
      case 'check': {
        const c = await check(platform, slug, opts);
        out({ ok: true, tenantId: c.tenant.id, slug, status: c.tenant.status, resuming: c.resuming, next: c.next, solo: c.run ? c.run.solo : solo });
        return 0;
      }
      case 'begin':
        out({ ok: true, purgeId: (await begin(platform, slug, opts)).id });
        return 0;
      case 'keys-done':
        if (!/^[0-9a-f-]{36}$/.test(flags.op ?? '')) throw new Error('keys-done needs --op <uuid>');
        await keysDone(platform, slug, flags.op ?? '');
        out({ ok: true, step: 'keys' });
        return 0;
      case 'rows':
        out({ ok: true, step: 'rows', rows: (await rows(platform, shards.of, slug)).rows });
        return 0;
      case 'objects':
        out({ ok: true, step: 'objects', objects: (await objects(platform, { s3, buckets }, slug)).objects });
        return 0;
      case 'platform':
        out({ ok: true, step: 'platform', platform: (await platformRows(platform, slug)).platformRows });
        return 0;
      case 'facts':
        out({ ok: true, facts: await facts(platform, slug) });
        return 0;
      case 'finish':
        if (!/^[0-9a-f]{64}$/.test(flags.sha256 ?? '')) throw new Error('finish needs --sha256 <hex>');
        await finish(platform, slug, await readStdin(), flags.sha256 ?? '');
        out({ ok: true, step: 'certificate' });
        return 0;
      default:
        throw new Error('usage: purge <check|begin|keys-done|rows|objects|platform|facts|finish> <slug> …');
    }
  } catch (e) {
    if (e instanceof PurgeRefused) {
      out({ ok: false, refused: e.why });
      return 3;
    }
    console.error((e as Error).message.split('\n')[0]?.slice(0, 200));
    return 1;
  } finally {
    s3.destroy();
    await Promise.all([platform.$disconnect(), shards.close()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
