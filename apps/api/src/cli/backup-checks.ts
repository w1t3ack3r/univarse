// Spec 0020 PR B1 (B-14): the read-only facts a backup records, and the checks a restore rehearsal runs, as `keys`
// subcommands of the deployed API image (so the host never reaches a database itself), plus the shred drill's tenant.
// Everything printed is ids, slugs, counts, versions, sequence numbers and hashes: never a key, a value or a secret.
//
//   backup-facts     B-7: the platform's WAL position, read FIRST in its transaction (the rehearsal restores to it with
//                    recovery_target_lsn), the platform audit chain's head and its row counts; then, one transaction per
//                    tenant (ShardRegistry has no other), each tenant's chain head and row counts, RLS-scoped.
//   verify-unwrap    every data key not destroyed unwraps through the key provider (Vault).
//   verify-decrypt   a sample of every tenant's encrypted values, per tenant: ok, key_destroyed, failed, or empty.
//   verify-chains    every audit chain verifies; with a checkpoint (stdin), each holds its recorded head exactly.
//   drill-tenant create <shred-drill-YYYYMMDD>   D11's drill tenant: suspended, no domain, no product, a data key, and
//                    a few encrypted values in outbox rows already DEAD (never delivered), audited on both chains.
import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCrypto, KeyUnavailableError, provisionTenantKey, verifyPlatformAuditChain, wrapContext, writePlatformAudit, type KeyProvider } from '@univarse/crypto';
import type { PlatformClient, TenantTx } from '@univarse/db';
import { AuditWriter, verifyAuditChain } from '../shared/audit/audit-writer.js';
import { ENCRYPTED_COLUMNS } from '../shared/crypto/encrypted-columns.js';
import type { ShardRegistry } from '../shared/db/db.module.js';
import { outboxAad } from '../shared/outbox/outbox.js';

export const DRILL_SLUG = /^shred-drill-\d{8}$/;
const SAMPLE = 5;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * Row counts of every table the current role may read, computed inside PostgreSQL: `format('%I')` quotes each table
 * name there, so no identifier is ever interpolated here. Under a tenant transaction, RLS scopes every count.
 */
async function counts(tx: { $queryRaw: TenantTx['$queryRaw'] }, tenantScoped: boolean): Promise<Record<string, string>> {
  const rows = await tx.$queryRaw<{ t: string; n: string }[]>`
    SELECT c.table_name AS t,
      (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.table_name), false, true, '')))[1]::text AS n
    FROM information_schema.tables c
    WHERE c.table_schema = 'public' AND c.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'
      AND has_table_privilege(format('public.%I', c.table_name), 'SELECT')
      AND (NOT ${tenantScoped} OR EXISTS (
        SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'tenant_id'))
    ORDER BY 1`;
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

export interface ChainHead {
  readonly seq: string;
  readonly hash: string;
}

export async function backupFacts(platform: PlatformClient, shards: ShardRegistry) {
  const p = await platform.$transaction(
    async (tx) => {
      // First, so the transaction's snapshot and this position are taken together (B-7).
      const [first] = await tx.$queryRaw<{ lsn: string }[]>`SELECT pg_current_wal_insert_lsn()::text AS lsn`;
      if (!first) throw new Error('no WAL position');
      const { lsn } = first;
      const head = await tx.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
      return { lsn, chain: head ? { seq: String(head.seq), hash: hex(head.hash) } : null, counts: await counts(tx, false) };
    },
    { isolationLevel: 'RepeatableRead' },
  );
  const tenants = await platform.tenant.findMany({ select: { id: true, slug: true, shardId: true }, orderBy: { slug: 'asc' } });
  const out: Record<string, { slug: string; chain: ChainHead | null; counts: Record<string, string> }> = {};
  for (const t of tenants)
    out[t.id] = await shards.tx(t.shardId, t.id, async (tx) => {
      const head = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
      return { slug: t.slug, chain: head ? { seq: String(head.seq), hash: hex(head.hash) } : null, counts: await counts(tx, true) };
    });
  return { platform: p, tenants: out };
}

export async function verifyUnwrap(platform: PlatformClient, provider: KeyProvider) {
  const keys = await platform.tenantDataKey.findMany({
    where: { status: { not: 'DESTROYED' } },
    select: { tenantId: true, version: true, wrappedDek: true, tenant: { select: { slug: true } } },
    orderBy: [{ tenantId: 'asc' }, { version: 'asc' }],
  });
  const failed: { tenant: string; version: number }[] = [];
  for (const k of keys) {
    try {
      if (!k.wrappedDek) throw new Error('no wrap');
      (await provider.unwrap(k.wrappedDek, wrapContext(k.tenantId, k.version))).fill(0);
    } catch {
      failed.push({ tenant: k.tenant.slug, version: k.version });
    }
  }
  return { ok: failed.length === 0, keys: keys.length, unwrapped: keys.length - failed.length, failed };
}

export type DecryptStatus = 'ok' | 'key_destroyed' | 'failed' | 'empty';

/** One tenant's verdict from its samples: every value decrypts, or every failure is a destroyed key, or not. */
export function decryptStatus(results: readonly ('ok' | 'key_destroyed' | 'failed')[]): DecryptStatus {
  if (!results.length) return 'empty';
  if (results.every((r) => r === 'ok')) return 'ok';
  if (results.every((r) => r === 'key_destroyed')) return 'key_destroyed';
  return 'failed';
}

export async function verifyDecrypt(platform: PlatformClient, shards: ShardRegistry, crypto: FieldCrypto) {
  const tenants = await platform.tenant.findMany({ select: { id: true, slug: true, shardId: true }, orderBy: { slug: 'asc' } });
  const out: Record<string, { status: DecryptStatus; sampled: number }> = {};
  for (const t of tenants) {
    const values = await shards.tx(t.shardId, t.id, async (tx) => (await Promise.all(ENCRYPTED_COLUMNS.map((c) => c.sample(tx, t.id, SAMPLE)))).flat());
    const results: ('ok' | 'key_destroyed' | 'failed')[] = [];
    for (const v of values) {
      try {
        (await crypto.decrypt(t.id, v.value, v.aad)).fill(0);
        results.push('ok');
      } catch (e) {
        results.push(e instanceof KeyUnavailableError && e.reason === 'key_destroyed' ? 'key_destroyed' : 'failed');
      }
    }
    out[t.slug] = { status: decryptStatus(results), sampled: results.length };
  }
  return out;
}

export interface Checkpoint {
  readonly platform: ChainHead | null;
  readonly tenants: Readonly<Record<string, { readonly chain: ChainHead | null }>>;
}

export async function verifyChains(platform: PlatformClient, shards: ShardRegistry, checkpoint: Checkpoint | null) {
  const problems: string[] = [];
  const p = await verifyPlatformAuditChain(platform);
  if (!p.ok) problems.push(`platform chain broken at seq ${String(p.brokenAtSeq)}`);
  const holds = (row: { hash: Uint8Array } | null, head: ChainHead) => row !== null && hex(row.hash) === head.hash;
  if (checkpoint?.platform) {
    const row = await platform.platformAuditEvent.findUnique({ where: { seq: BigInt(checkpoint.platform.seq) }, select: { hash: true } });
    if (!holds(row, checkpoint.platform)) problems.push(`platform chain does not hold the checkpoint's seq ${checkpoint.platform.seq} with its hash`);
  }
  const tenants = await platform.tenant.findMany({ select: { id: true, slug: true, shardId: true }, orderBy: { slug: 'asc' } });
  for (const t of tenants) {
    const r = await shards.tx(t.shardId, t.id, async (tx) => {
      const v = await verifyAuditChain(tx, t.id);
      const head = checkpoint?.tenants[t.id]?.chain;
      const at = head ? await tx.auditEvent.findFirst({ where: { seq: BigInt(head.seq) }, select: { hash: true } }) : null;
      return { v, ok: !head || holds(at, head) };
    });
    if (!r.v.ok) problems.push(`${t.slug}: chain broken at seq ${String(r.v.brokenAtSeq)} (${r.v.reason})`);
    if (!r.ok) problems.push(`${t.slug}: chain does not hold the checkpoint's head`);
  }
  if (checkpoint) for (const id of Object.keys(checkpoint.tenants)) if (!tenants.some((t) => t.id === id)) problems.push(`tenant ${id} is in the checkpoint but not restored`);
  return { ok: problems.length === 0, tenants: tenants.length, problems };
}

export async function createDrillTenant(platform: PlatformClient, shards: ShardRegistry, provider: KeyProvider, crypto: FieldCrypto, audit: AuditWriter, slug: string) {
  if (!DRILL_SLUG.test(slug)) throw new Error('a drill tenant is named shred-drill-YYYYMMDD');
  if (await platform.tenant.findUnique({ where: { slug }, select: { id: true } })) throw new Error(`${slug} exists: each drill gets a fresh tenant`);
  const shard = await platform.shard.findFirstOrThrow({ where: { kind: 'POOL', isActive: true }, orderBy: { id: 'asc' }, select: { id: true } });
  const tenant = await platform.$transaction(async (tx) => {
    // Suspended, with no domain and no product: no request can ever reach it.
    const t = await tx.tenant.create({
      data: { slug, legalName: 'Shred drill (not an institution)', shortName: 'Shred drill', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'SUSPENDED', shardId: shard.id },
      select: { id: true, shardId: true },
    });
    await writePlatformAudit(tx, { actorId: null, action: 'tenant.drill_created', tenantId: t.id, metadata: { slug, spec: '0020 D11' } });
    return t;
  });
  const key = await provisionTenantKey(platform, provider, tenant.id);
  const written = await shards.tx(tenant.shardId, tenant.id, async (tx) => {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const payloadEnc = await crypto.encrypt(tenant.id, randomBytes(48), outboxAad(tenant.id, id));
      // DEAD: the relay never picks it up, so the value stays for the drill and is never delivered.
      await tx.outboxEvent.create({ data: { id, tenantId: tenant.id, type: 'drill.shred_sample', status: 'DEAD', payloadEnc } });
    }
    await audit.write(tx, tenant.id, { actorType: 'SYSTEM', actorId: null, action: 'drill.shred_values_written', entityType: 'tenant', entityId: tenant.id, after: { values: 3 } });
    return 3;
  });
  return { tenant: slug, tenantId: tenant.id, keyVersion: key.version, values: written };
}
