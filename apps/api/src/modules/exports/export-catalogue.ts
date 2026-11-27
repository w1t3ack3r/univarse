// Spec 0038 Q7, Q-B3: what the institution's export holds, table by table and column by column. Every tenant table and
// every column is here, either exported or left out with its reason; `export-catalogue.int.spec.ts` reads the
// database's own catalogue and fails on any that isn't, so a new column can't slip into an export (or out of one)
// unclassified. Nothing here lets anyone sign in: no password, token, code or recovery hash, authenticator secret,
// session, challenge or outbox payload.
//
// Each table's SELECT is its own static SQL (tagged templates, no identifier interpolation), as encrypted-columns.ts.
import type { TenantTx } from '@univarse/db';
import { contactAad } from '../identity/contact.service.js';

/** Why a whole table, or one column, stays out. */
export type Exclusion = 'secret' | 'session' | 'plumbing';

export interface ExportedTable {
  readonly table: string;
  /** The columns written, in this order, by their database names. */
  readonly columns: readonly string[];
  /** The columns left out, each with why. */
  readonly excluded: Readonly<Record<string, Exclusion>>;
  /** Encrypted columns that are decrypted into the export, under the name without `_enc`, with their AAD. */
  readonly decrypted?: Readonly<Record<string, (tenantId: string, row: Record<string, unknown>) => string>>;
  /** Up to `limit` rows after `afterId`, in id order, every exported column. Read inside the export's snapshot. */
  page(tx: TenantTx, tenantId: string, afterId: string, limit: number): Promise<Record<string, unknown>[]>;
}

/** Tables left out entirely, with why. */
export const EXCLUDED_TABLES: Readonly<Record<string, Exclusion>> = {
  session: 'session',
  mfa_challenge: 'session',
  recovery_code: 'secret',
  one_time_token: 'secret',
  // Delivery bookkeeping; a pending payload may hold a code (spec 0002 B2).
  outbox_event: 'plumbing',
};

const ZERO = '00000000-0000-0000-0000-000000000000';
export const FIRST_ID = ZERO;

export const EXPORTED_TABLES: readonly ExportedTable[] = [
  {
    table: 'org_unit',
    // Spec 0042: `kind`, `type` and `status` are the old columns (Q16), exported while they exist.
    columns: ['id', 'tenant_id', 'code', 'name', 'description', 'kind', 'type', 'type_id', 'parent_id', 'path', 'status', 'state', 'code_locked_at', 'created_at', 'updated_at', 'version'],
    // The request key a create was retried with (Q-A2): meaningless outside the API.
    excluded: { creation_key: 'plumbing' },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, code, name, description, kind::text, type::text, type_id::text, parent_id::text, path, status::text, state::text,
        code_locked_at, created_at, updated_at, version
      FROM org_unit WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  // Spec 0042: the institution's unit types, their rules, every code it has used, and its structure's history.
  {
    table: 'org_unit_type',
    columns: ['id', 'tenant_id', 'key', 'name', 'kind', 'sort_order', 'status', 'created_at', 'updated_at', 'version'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, key, name, kind::text, sort_order, status::text, created_at, updated_at, version
      FROM org_unit_type WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'org_unit_type_rule',
    columns: ['id', 'tenant_id', 'parent_type_id', 'child_type_id'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, parent_type_id::text, child_type_id::text
      FROM org_unit_type_rule WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'org_unit_code',
    columns: ['id', 'tenant_id', 'code', 'unit_id', 'created_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, code, unit_id::text, created_at
      FROM org_unit_code WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'org_unit_change',
    columns: ['id', 'tenant_id', 'seq', 'unit_id', 'kind', 'code', 'name', 'description', 'type_id', 'parent_id', 'state', 'effective_from', 'actor_id', 'reason', 'created_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, seq, unit_id::text, kind::text, code, name, description, type_id::text, parent_id::text, state::text,
        to_char(effective_from, 'YYYY-MM-DD') AS effective_from, actor_id::text, reason, created_at
      FROM org_unit_change WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'user_account',
    columns: ['id', 'tenant_id', 'username', 'email', 'email_verified_at', 'phone', 'display_name', 'password_reset_required', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'version'],
    excluded: { password_hash: 'secret' },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, username, email, email_verified_at, phone, display_name, password_reset_required, status::text,
        failed_login_count, locked_until, last_login_at, created_at, updated_at, version
      FROM user_account WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'contact_change',
    columns: ['id', 'tenant_id', 'user_id', 'channel', 'kind', 'status', 'requested_by', 'new_address', 'old_address', 'old_address_wrong', 'attempts', 'expires_at', 'confirmed_at', 'undo_until', 'undo_attempts', 'undone_at', 'blanked_at', 'created_at'],
    excluded: { code_hash: 'secret', undo_hash: 'secret', new_address_hash: 'secret', old_address_hash: 'secret' },
    decrypted: {
      new_address_enc: (tenantId, row) => contactAad(tenantId, String(row.id), 'new'),
      old_address_enc: (tenantId, row) => contactAad(tenantId, String(row.id), 'old'),
    },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, user_id::text, channel::text, kind::text, status::text, requested_by::text, new_address_enc, old_address_enc,
        old_address_wrong, attempts, expires_at, confirmed_at, undo_until, undo_attempts, undone_at, blanked_at, created_at
      FROM contact_change WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'mfa_factor',
    columns: ['id', 'tenant_id', 'user_id', 'type', 'label', 'confirmed_at', 'last_used_at', 'last_used_step', 'created_at'],
    excluded: { secret_enc: 'secret' },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, user_id::text, type::text, label, confirmed_at, last_used_at, last_used_step, created_at
      FROM mfa_factor WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'role',
    columns: ['id', 'tenant_id', 'key', 'name', 'description', 'is_system', 'permissions', 'created_at', 'updated_at', 'version'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, key, name, description, is_system, permissions, created_at, updated_at, version
      FROM role WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'role_assignment',
    columns: ['id', 'tenant_id', 'user_id', 'role_id', 'scope_type', 'scope_id', 'valid_from', 'valid_to', 'granted_by_id', 'reason', 'revoked_at', 'created_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, user_id::text, role_id::text, scope_type::text, scope_id::text, valid_from, valid_to, granted_by_id::text,
        reason, revoked_at, created_at
      FROM role_assignment WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    // Q14: the institution receives its audit chain, hashes included, so it can check the chain itself.
    table: 'audit_event',
    columns: ['id', 'tenant_id', 'seq', 'occurred_at', 'actor_type', 'actor_id', 'action', 'entity_type', 'entity_id', 'before', 'after', 'reason', 'ip', 'user_agent', 'request_id', 'prev_hash', 'hash'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, seq, occurred_at, actor_type, actor_id::text, action, entity_type, entity_id::text, before, after, reason,
        ip, user_agent, request_id, prev_hash, hash
      FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'setting',
    columns: ['id', 'tenant_id', 'key', 'scope_key', 'value', 'updated_by', 'created_at', 'updated_at', 'version'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, key, scope_key, value, updated_by::text, created_at, updated_at, version
      FROM setting WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    // Spec 0041 Q4: the profile the institution was assigned, as it was. Its own configuration, so it goes with it.
    table: 'institution_profile',
    columns: ['id', 'tenant_id', 'template', 'template_version', 'content_hash', 'profile', 'source', 'assigned_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, template, template_version, content_hash, profile, source::text, assigned_at
      FROM institution_profile WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'file_object',
    columns: ['id', 'tenant_id', 'bucket_key', 'original_name', 'mime', 'size_bytes', 'sha256', 'scan_status', 'classification', 'owner_type', 'owner_id', 'uploaded_by_id', 'created_at', 'state', 'detected_type', 'rejection_reason', 'scan_signature', 'scan_attempts', 'next_scan_at', 'lease_until', 'quarantine_key', 'clean_key', 'reserved_bytes', 'upload_expires_at', 'completed_at', 'scanned_at', 'deleted_at', 'updated_at', 'traceparent'],
    // A worker's claim on a scan: meaningless outside it.
    excluded: { lease_token: 'plumbing' },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, bucket_key, original_name, mime, size_bytes, sha256, scan_status::text, classification::text, owner_type,
        owner_id::text, uploaded_by_id::text, created_at, state::text, detected_type, rejection_reason, scan_signature, scan_attempts, next_scan_at,
        lease_until, quarantine_key, clean_key, reserved_bytes, upload_expires_at, completed_at, scanned_at, deleted_at, updated_at, traceparent
      FROM file_object WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'sequence',
    columns: ['id', 'tenant_id', 'name', 'next_value', 'updated_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, name, next_value, updated_at
      FROM sequence WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'notice_dismissal',
    columns: ['id', 'tenant_id', 'user_id', 'notice_id', 'dismissed_at'],
    excluded: {},
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, user_id::text, notice_id::text, dismissed_at
      FROM notice_dismissal WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
  {
    table: 'data_export',
    columns: ['id', 'tenant_id', 'state', 'requested_by', 'requested_at', 'attempts', 'lease_until', 'object_key', 'size_bytes', 'sha256', 'tables', 'rows', 'files', 'started_at', 'ready_at', 'expires_at', 'failed_at', 'expired_at', 'last_error', 'updated_at', 'version'],
    excluded: { passphrase_enc: 'secret', lease_token: 'plumbing' },
    page: (tx, tenantId, afterId, limit) => tx.$queryRaw`
      SELECT id::text, tenant_id::text, state::text, requested_by::text, requested_at, attempts, lease_until, object_key, size_bytes, sha256, tables,
        rows, files, started_at, ready_at, expires_at, failed_at, expired_at, last_error, updated_at, version
      FROM data_export WHERE tenant_id = ${tenantId}::uuid AND id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
  },
];

/** A row as one JSON line: dates as ISO 8601, binary as hex, large integers as strings; encrypted values decrypted. */
export function jsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(jsonValue);
  return v;
}
