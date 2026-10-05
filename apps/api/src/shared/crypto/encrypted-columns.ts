// Every field-encrypted column in the tenant schema (spec 0006 PR B). The key sweep re-encrypts these
// on rotation and the v1 migration, and the retired-key check counts them. A test discovers every
// `*_enc` column in the catalog and fails if one is missing here. Each entry has its own static SQL
// (tagged templates only, no identifier interpolation).
import type { TenantTx } from '@univarse/db';
import { mfaSecretAad } from '../../modules/identity/mfa.service.js';
import { outboxAad } from '../outbox/outbox.js';

/** One encrypted value, locked for re-encryption, with the AAD it was sealed under. */
export interface LockedValue {
  readonly id: string;
  readonly value: string;
  readonly aad: string;
}

/** Count of values per cipher format and key version (`v1` rows: version = legacy key id). */
export interface VersionCount {
  readonly format: string;
  readonly version: string;
  readonly n: number;
}

export interface EncryptedColumn {
  readonly table: string;
  readonly column: string;
  /**
   * Up to `limit` values NOT on `activePrefix` (e.g. `v2:3:%`) with id > `afterId`, in id order,
   * locked FOR UPDATE SKIP LOCKED. The cursor lets a pass move past values it had to skip.
   */
  lockStale(tx: TenantTx, tenantId: string, activePrefix: string, afterId: string, limit: number): Promise<LockedValue[]>;
  /** Compare-and-swap: replaces the value only if it is still `old`. Returns rows changed (0 or 1). */
  swap(tx: TenantTx, tenantId: string, id: string, old: string, next: string): Promise<number>;
  count(tx: TenantTx, tenantId: string): Promise<VersionCount[]>;
}

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    table: 'mfa_factor',
    column: 'secret_enc',
    async lockStale(tx, tenantId, activePrefix, afterId, limit) {
      const rows = await tx.$queryRaw<{ id: string; value: string; user_id: string }[]>`
        SELECT id::text, secret_enc AS value, user_id::text FROM mfa_factor
        WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid AND secret_enc NOT LIKE ${activePrefix}
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      return rows.map((r) => ({ id: r.id, value: r.value, aad: mfaSecretAad(tenantId, r.user_id) }));
    },
    swap: (tx, tenantId, id, old, next) =>
      tx.$executeRaw`UPDATE mfa_factor SET secret_enc = ${next}
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND secret_enc = ${old}`,
    count: (tx, tenantId) =>
      tx.$queryRaw<VersionCount[]>`
        SELECT split_part(secret_enc, ':', 1) AS format, split_part(secret_enc, ':', 2) AS version, count(*)::int AS n
        FROM mfa_factor WHERE tenant_id = ${tenantId}::uuid GROUP BY 1, 2`,
  },
  {
    // NULL once delivered (spec 0002 B2): only pending and dead events hold a payload.
    table: 'outbox_event',
    column: 'payload_enc',
    async lockStale(tx, tenantId, activePrefix, afterId, limit) {
      const rows = await tx.$queryRaw<{ id: string; value: string }[]>`
        SELECT id::text, payload_enc AS value FROM outbox_event
        WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid AND payload_enc IS NOT NULL AND payload_enc NOT LIKE ${activePrefix}
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      return rows.map((r) => ({ id: r.id, value: r.value, aad: outboxAad(tenantId, r.id) }));
    },
    swap: (tx, tenantId, id, old, next) =>
      tx.$executeRaw`UPDATE outbox_event SET payload_enc = ${next}
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND payload_enc = ${old}`,
    count: (tx, tenantId) =>
      tx.$queryRaw<VersionCount[]>`
        SELECT split_part(payload_enc, ':', 1) AS format, split_part(payload_enc, ':', 2) AS version, count(*)::int AS n
        FROM outbox_event WHERE tenant_id = ${tenantId}::uuid AND payload_enc IS NOT NULL GROUP BY 1, 2`,
  },
];
