// Spec 0038 Q7, Q8, Q-B2, Q-B6 (T35): builds one export. The export's institution is the platform mirror's, which the
// worker's own pass wrote from the registry; the queue carries the export's id and nothing else, and the export is then
// read under that institution's RLS, so a job can never reach another institution's data. Its claim is a lease with
// its own token, and the archive's key carries the token too, so a builder that lost its lease never overwrites the
// archive another one sealed. Nothing touches the disk: the tables (one read-only snapshot) and then the clean files
// stream through zip.js's AES-256 writer into a multipart upload. Postgres holds every state.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldCrypto } from '@univarse/crypto';
import { archiveFileName, EXPORT_MAX_ATTEMPTS, exportableStatus, exportExpiresAt } from '@univarse/domain';
import type { PlatformClient, TenantTx } from '@univarse/db';
import { configure, TextReader, ZipWriter } from '@zip.js/zip.js';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { FileStorage, type MultipartWrite } from '../files/file-storage.js';
import { EXCLUDED_TABLES, EXPORTED_TABLES, FIRST_ID, jsonValue } from './export-catalogue.js';
import { exportArchiveKey, exportPassphraseAad } from './export-keys.js';
import { ExportMirror } from './export-mirror.js';

// zip.js's web workers are a browser feature; in Node it runs inline.
configure({ useWebWorkers: false });

/** How long a claim lasts before another pass may take the export over. */
export const EXPORT_LEASE_MS = 30 * 60_000;
/** Q-B6: the tables' snapshot may run this long. */
export const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
const PAGE = 500;
const RETRY_AFTER_MS = 60_000;


interface Manifest {
  format: 'univarse-export-1';
  institution: { id: string; slug: string; legalName: string };
  exportId: string;
  snapshotAt: string;
  tables: { name: string; file: string; rows: number; bytes: number; sha256: string }[];
  excludedTables: Record<string, string>;
  excludedColumns: Record<string, Record<string, string>>;
  files: { id: string; path: string; bytes: number; sha256: string; recordedSha256: string | null; matches: boolean }[];
  missingFiles: { id: string; reason: 'missing' }[];
}

interface CleanFile {
  id: string;
  clean_key: string;
  original_name: string;
  sha256: Uint8Array | null;
}

export type BuildOutcome = 'ready' | 'retry' | 'failed' | 'skipped';

@Injectable()
export class ExportBuilder {
  private readonly logger = new Logger('Export');

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly storage: FileStorage,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditWriter,
    private readonly mirror: ExportMirror,
  ) {}

  /** Builds the export if it's still waiting (or its builder's lease ran out). */
  async build(exportId: string, now = new Date()): Promise<BuildOutcome> {
    const m = await this.platform.platformTenantExport.findUnique({
      where: { id: exportId },
      select: { tenantId: true, tenant: { select: { status: true, shardId: true, slug: true, legalName: true } } },
    });
    if (!m) return 'skipped';
    const t = { id: m.tenantId, ...m.tenant };
    // A suspended institution's export waits; the pass fails an archived one's (Q5: no export after the window).
    if (!exportableStatus(t.status)) return 'skipped';
    const token = randomUUID();
    const claim = await this.shards.tx(t.shardId, t.id, async (tx) => {
      const [row] = await tx.$queryRaw<{ passphrase_enc: string; attempts: number }[]>`
        UPDATE data_export SET state = 'BUILDING', attempts = attempts + 1, lease_until = ${new Date(now.getTime() + EXPORT_LEASE_MS)},
          lease_token = ${token}::uuid, started_at = COALESCE(started_at, ${now}), updated_at = ${now}, version = version + 1
        WHERE tenant_id = ${t.id}::uuid AND id = ${exportId}::uuid
          AND (state = 'REQUESTED' OR (state = 'BUILDING' AND (lease_until IS NULL OR lease_until < ${now})))
        RETURNING passphrase_enc, attempts`;
      return row ?? null;
    });
    if (!claim) return 'skipped';
    await this.mirror.sync(t.id, t.shardId, exportId);
    // A builder that died mid-build (a crash, not a caught failure) left its claim to lapse: past the last attempt, stop.
    if (claim.attempts > EXPORT_MAX_ATTEMPTS) return this.fail(t, exportId, token, claim.attempts, 'TooManyAttempts');
    const key = exportArchiveKey(t.id, exportId, token);
    let upload: MultipartWrite | null = null;
    try {
      const passphrase = (await this.crypto.decrypt(t.id, claim.passphrase_enc, exportPassphraseAad(t.id, exportId))).toString('utf8');
      upload = await this.storage.multipart(this.storage.exports, key, 'application/zip');
      const sealed = await this.write(t, exportId, passphrase, upload);
      await upload.finish();
      const readyAt = new Date();
      const done = await this.shards.tx(t.shardId, t.id, async (tx) => {
        const n = await tx.$executeRaw`
          UPDATE data_export SET state = 'READY', passphrase_enc = NULL, lease_until = NULL, lease_token = NULL, object_key = ${key},
            size_bytes = ${sealed.bytes}, sha256 = decode(${Buffer.from(sealed.sha256).toString('hex')}, 'hex'), tables = ${sealed.tables}, rows = ${sealed.rows}, files = ${sealed.files},
            ready_at = ${readyAt}, expires_at = ${exportExpiresAt(readyAt)}, last_error = NULL, updated_at = ${readyAt}, version = version + 1
          WHERE tenant_id = ${t.id}::uuid AND id = ${exportId}::uuid AND state = 'BUILDING' AND lease_token = ${token}::uuid`;
        if (n !== 1) return false;
        await this.audit.write(tx, t.id, {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'data.export.ready',
          entityType: 'data_export',
          entityId: exportId,
          after: { state: 'READY', bytes: sealed.bytes, tables: sealed.tables, rows: sealed.rows, files: sealed.files, sha256: Buffer.from(sealed.sha256).toString('hex') },
        });
        return true;
      });
      if (!done) {
        // Another builder took the export over: this archive is nobody's.
        await this.storage.remove(this.storage.exports, key);
        return 'skipped';
      }
      await this.mirror.sync(t.id, t.shardId, exportId);
      this.logger.log({ event: 'export.ready', tenantId: t.id, exportId, bytes: Number(sealed.bytes), rows: Number(sealed.rows), files: sealed.files }, 'Export ready');
      return 'ready';
    } catch (err) {
      const error = err instanceof Error ? err.name : 'unknown';
      await upload?.abort().catch(() => undefined);
      await this.storage.remove(this.storage.exports, key).catch(() => undefined);
      const outcome = await this.fail(t, exportId, token, claim.attempts, error);
      this.logger.warn({ event: outcome === 'failed' ? 'export.failed' : 'export.retry', tenantId: t.id, exportId, attempts: claim.attempts, error }, 'An export failed');
      return outcome;
    }
  }

  /** Q-B5: after the last attempt, FAILED and the passphrase wiped; before it, the claim is let go for a later pass. */
  private async fail(t: { id: string; shardId: string }, exportId: string, token: string, attempts: number, error: string): Promise<BuildOutcome> {
    const now = new Date();
    const last = attempts >= EXPORT_MAX_ATTEMPTS;
    const changed = await this.shards.tx(t.shardId, t.id, async (tx) => {
      const n = last
        ? await tx.$executeRaw`
            UPDATE data_export SET state = 'FAILED', passphrase_enc = NULL, lease_until = NULL, lease_token = NULL, failed_at = ${now},
              last_error = ${error}, updated_at = ${now}, version = version + 1
            WHERE tenant_id = ${t.id}::uuid AND id = ${exportId}::uuid AND state = 'BUILDING' AND lease_token = ${token}::uuid`
        : await tx.$executeRaw`
            UPDATE data_export SET lease_until = ${new Date(now.getTime() + RETRY_AFTER_MS)}, lease_token = NULL, last_error = ${error},
              updated_at = ${now}, version = version + 1
            WHERE tenant_id = ${t.id}::uuid AND id = ${exportId}::uuid AND state = 'BUILDING' AND lease_token = ${token}::uuid`;
      if (n === 1 && last) {
        await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action: 'data.export.failed', entityType: 'data_export', entityId: exportId, after: { state: 'FAILED', attempts, error } });
      }
      return n === 1;
    });
    if (changed) await this.mirror.sync(t.id, t.shardId, exportId);
    return changed && last ? 'failed' : 'retry';
  }

  /** The archive: the tables in one snapshot, then the files that snapshot listed, the manifest and the README. */
  private async write(
    t: { id: string; shardId: string; slug: string; legalName: string },
    exportId: string,
    passphrase: string,
    upload: MultipartWrite,
  ): Promise<{ bytes: bigint; sha256: Uint8Array; tables: number; rows: bigint; files: number }> {
    const archiveHash = createHash('sha256');
    let archiveBytes = 0n;
    const sink = new WritableStream<Uint8Array>({
      async write(chunk) {
        archiveHash.update(chunk);
        archiveBytes += BigInt(chunk.byteLength);
        await upload.write(chunk);
      },
    });
    // Q8: AES-256 (WinZip AE-2), never the legacy ZipCrypto.
    const zip = new ZipWriter(sink, { password: passphrase, encryptionStrength: 3, zipCrypto: false, level: 6, keepOrder: true });
    const manifest: Manifest = {
      format: 'univarse-export-1',
      institution: { id: t.id, slug: t.slug, legalName: t.legalName },
      exportId,
      snapshotAt: '',
      tables: [],
      excludedTables: { ...EXCLUDED_TABLES },
      excludedColumns: Object.fromEntries(EXPORTED_TABLES.filter((x) => Object.keys(x.excluded).length).map((x) => [x.table, { ...x.excluded }])),
      files: [],
      missingFiles: [],
    };
    const cleanFiles = await this.shards.tx(
      t.shardId,
      t.id,
      async (tx) => {
        // Q-B6: one moment's data (REPEATABLE READ, from the transaction's options), and nothing written by it.
        await tx.$executeRaw`SET LOCAL transaction_read_only = on`;
        const [first] = await tx.$queryRaw<{ at: Date }[]>`SELECT now() AS at`;
        manifest.snapshotAt = (first?.at ?? new Date()).toISOString();
        for (const table of EXPORTED_TABLES) manifest.tables.push(await this.table(tx, t.id, table, zip));
        return tx.$queryRaw<CleanFile[]>`
          SELECT id::text, clean_key, original_name, sha256 FROM file_object
          WHERE tenant_id = ${t.id}::uuid AND state = 'CLEAN' AND deleted_at IS NULL AND clean_key IS NOT NULL ORDER BY id`;
      },
      { timeoutMs: SNAPSHOT_TIMEOUT_MS, isolationLevel: 'RepeatableRead' },
    );
    for (const f of cleanFiles) {
      const read = await this.storage.stream(this.storage.clean, f.clean_key);
      if (read.kind === 'missing') {
        manifest.missingFiles.push({ id: f.id, reason: 'missing' });
        continue;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      const path = archiveFileName(f.id, f.original_name);
      const counted = Readable.toWeb(read.body) as ReadableStream<Uint8Array>;
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          c.enqueue(chunk);
        },
      });
      await zip.add(path, counted.pipeThrough(tap));
      const sha256 = hash.digest('hex');
      const recorded = f.sha256 ? Buffer.from(f.sha256).toString('hex') : null;
      manifest.files.push({ id: f.id, path, bytes, sha256, recordedSha256: recorded, matches: recorded === sha256 });
    }
    await zip.add('manifest.json', new TextReader(`${JSON.stringify(manifest, null, 2)}\n`));
    await zip.add('README.txt', new TextReader(readme(t.legalName, manifest)));
    await zip.close();
    const rows = manifest.tables.reduce((n, x) => n + BigInt(x.rows), 0n);
    return { bytes: archiveBytes, sha256: new Uint8Array(archiveHash.digest()), tables: manifest.tables.length, rows, files: manifest.files.length };
  }

  /** One table as JSON Lines, page by page inside the snapshot; encrypted columns decrypted under their own AAD. */
  private async table(tx: TenantTx, tenantId: string, table: (typeof EXPORTED_TABLES)[number], zip: ZipWriter<unknown>): Promise<Manifest['tables'][number]> {
    const file = `tables/${table.table}.jsonl`;
    const hash = createHash('sha256');
    let bytes = 0;
    let rows = 0;
    const lines = new TransformStream<Uint8Array, Uint8Array>();
    const added = zip.add(file, lines.readable);
    const writer = lines.writable.getWriter();
    try {
      let after = FIRST_ID;
      for (;;) {
        const page = await table.page(tx, tenantId, after, PAGE);
        if (page.length === 0) break;
        const out: string[] = [];
        for (const raw of page) {
          const row: Record<string, unknown> = {};
          for (const [col, aad] of Object.entries(table.decrypted ?? {})) {
            const v = raw[col];
            row[col.replace(/_enc$/, '')] = typeof v === 'string' ? (await this.crypto.decrypt(tenantId, v, aad(tenantId, raw))).toString('utf8') : null;
          }
          const obj: Record<string, unknown> = {};
          for (const col of table.columns) obj[col] = col in row ? row[col] : jsonValue(raw[col]);
          out.push(`${JSON.stringify(obj)}\n`);
        }
        const chunk = Buffer.from(out.join(''), 'utf8');
        hash.update(chunk);
        bytes += chunk.length;
        rows += page.length;
        await writer.write(new Uint8Array(chunk));
        after = String(page[page.length - 1]?.id);
        if (page.length < PAGE) break;
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => undefined);
      await added.catch(() => undefined);
      throw err;
    }
    await added;
    return { name: table.table, file, rows, bytes, sha256: hash.digest('hex') };
  }
}

function readme(legalName: string, m: Manifest): string {
  return [
    `${legalName}: the institution's data from UniVarse`,
    '',
    `Taken at ${m.snapshotAt} (UTC), export ${m.exportId}.`,
    '',
    'What is here:',
    '',
    '- tables/: one file for each table of the institution\'s records, in JSON Lines: one JSON object a line, one line a',
    '  row. Each key is the column\'s name. Dates and times are ISO 8601 in UTC; binary values (hashes) are hexadecimal;',
    '  large whole numbers are strings, so no tool rounds them.',
    '- files/: every document people uploaded and that passed its virus check, as uploaded, each in a folder named by',
    '  its id (the `id` in tables/file_object.jsonl).',
    '- manifest.json: how many rows each table holds and the SHA-256 of every file, so you can check nothing is missing',
    '  or changed. `matches` says whether a document\'s bytes are the ones recorded when it was uploaded.',
    '',
    'What is not here, on purpose: passwords, sign-in and recovery codes, authenticator secrets, sessions, and email',
    'still waiting to be sent. Nothing in this archive lets anyone sign in. manifest.json lists what was left out.',
    '',
    'audit_event.jsonl is the institution\'s audit trail. Each event\'s `hash` covers the event and the one before it',
    '(`prev_hash`), so the order and content of the trail can be checked.',
    '',
    'Keep this archive and its passphrase apart, and somewhere only the people who need it can reach.',
    '',
  ].join('\r\n');
}
