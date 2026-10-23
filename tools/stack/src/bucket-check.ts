// Spec 0020 (A2-10, A3-5): the shred ledger's bucket copy, checked after a deploy. Read-only unless --try-delete.
//   pnpm stack:bucket-check [--try-delete]
// S3 through the edge (https://files.stack.univarse.localhost, resolved to 127.0.0.1, verified against the edge CA),
// as both identities in secrets.json. Prints PASS and FAIL lines only, never a key; exit 0 only when every line passes.
// Evidence only: the copy on disk is the authority (D7), so this reports and never repairs.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, type AgentOptions } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { objectKey, SHRED_LEDGER_BUCKET, SHRED_LEDGER_RETENTION_YEARS } from '../../../apps/api/src/cli/ledger-copy.js';
import { edgeDir } from './certs.js';
import { STACK_DOMAIN } from './config.js';
import { canonical, type Entry } from './ledger/chain.js';
import { generationOfRecord } from './ledger/ledger.js';
import { bucketDir, readCopy } from './ledger/store.js';
import { PRIMARY } from './keys.js';
import { loadSecrets } from './secrets.js';

/** The other buckets: the ledger identity must reach neither (the API's defaults, as the deploy creates them). */
export const OTHER_BUCKETS = ['uv-quarantine', 'uv-clean'] as const;

/** What the check reads: the ledger on disk at its generation of record, and a client per identity. */
export interface BucketCheckInput {
  readonly ledger: { readonly ledgerId: string; readonly dir: string; readonly entries: readonly Entry[] } | { readonly problem: string };
  readonly app: Pick<S3Client, 'send'>;
  readonly ledgerIdentity: Pick<S3Client, 'send'>;
  readonly tryDelete?: boolean;
}

/** An S3 error as a name and status only: never a message that could echo a request. */
const why = (e: unknown) => {
  const err = e as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  // A connection or TLS failure has no status, but a code (ECONNREFUSED, UNABLE_TO_VERIFY_LEAF_SIGNATURE…).
  return `${err.name ?? 'Error'} (${String(err.$metadata?.httpStatusCode ?? err.code ?? 'no status')})`;
};
const denied = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403;

/** Every object under a prefix, as the app identity lists them. */
async function listAll(app: BucketCheckInput['app'], Prefix: string): Promise<_Object[]> {
  const out: _Object[] = [];
  let token: string | undefined;
  do {
    const page = await app.send(new ListObjectsV2Command({ Bucket: SHRED_LEDGER_BUCKET, Prefix, ...(token ? { ContinuationToken: token } : {}) }));
    out.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

const SEQ = /\/(\d{10})-[0-9a-f]{64}\.json$/;
/** COMPLIANCE for 10 years from the write, give or take a day (the copy sets it from the job's clock). */
const DAY_MS = 86_400_000;

/** The checks, in order. Each returns its lines; a check that can't run says why in a FAIL line. */
export async function bucketCheck(input: BucketCheckInput): Promise<string[]> {
  const lines: string[] = [];
  const pass = (s: string) => lines.push(`PASS ${s}`);
  const fail = (s: string) => lines.push(`FAIL ${s}`);
  const { app, ledgerIdentity: led } = input;
  if ('problem' in input.ledger) {
    fail(`the ledger on disk can't be read, so there is nothing to compare: ${input.ledger.problem}`);
    return lines;
  }
  const { ledgerId, dir, entries } = input.ledger;
  const genesis = entries[0];
  if (genesis?.type !== 'genesis') {
    fail(`the ledger on disk at ${dir} doesn't start with its genesis`);
    return lines;
  }
  const prefix = `${ledgerId}/${dir}/`;
  const genesisKey = objectKey(ledgerId, dir, genesis);

  // ── The app identity can list and read the bucket (A3-5: the waiver's ledger-bucket-read).
  let listed: _Object[];
  try {
    listed = await listAll(app, prefix);
    const first = listed[0]?.Key;
    if (first) {
      const body = await app.send(new GetObjectCommand({ Bucket: SHRED_LEDGER_BUCKET, Key: first }));
      await body.Body?.transformToString('utf8');
      pass(`the app identity can list and read ${SHRED_LEDGER_BUCKET} (ledger-bucket-read)`);
    } else pass(`the app identity can list ${SHRED_LEDGER_BUCKET} (ledger-bucket-read; it holds nothing of this ledger to read)`);
  } catch (e) {
    // Every check below reads through it: without it, they would report an empty bucket that isn't.
    fail(`the app identity can't list or read ${SHRED_LEDGER_BUCKET}, so nothing else can be checked: ${why(e)}`);
    return lines;
  }

  // ── This ledger's chain is in the bucket from its genesis, with no gap.
  const seqs = listed.map((o) => Number(SEQ.exec(o.Key ?? '')?.[1] ?? NaN)).filter((n) => Number.isInteger(n));
  const top = Math.max(0, ...seqs);
  const gaps = Array.from({ length: top }, (_, i) => i + 1).filter((n) => !seqs.includes(n));
  if (!listed.some((o) => o.Key === genesisKey)) fail(`ledger ${ledgerId} (${dir}): its genesis is not in the bucket`);
  else if (gaps.length) fail(`ledger ${ledgerId} (${dir}): the bucket's chain has gaps at seq ${gaps.slice(0, 10).join(', ')}`);
  else pass(`ledger ${ledgerId} (${dir}): the bucket holds its chain from the genesis, seq 1 to ${String(top)}, with no gap`);

  // ── Every entry on disk is copied, byte for byte.
  const byKey = new Map(listed.map((o) => [o.Key ?? '', o]));
  const missing: number[] = [];
  const differs: number[] = [];
  for (const e of entries) {
    const key = objectKey(ledgerId, dir, e);
    if (!byKey.has(key)) {
      missing.push(e.seq);
      continue;
    }
    try {
      const body = await app.send(new GetObjectCommand({ Bucket: SHRED_LEDGER_BUCKET, Key: key }));
      if ((await body.Body?.transformToString('utf8'))?.trim() !== canonical(e)) differs.push(e.seq);
    } catch {
      differs.push(e.seq);
    }
  }
  if (missing.length) fail(`${String(missing.length)} of ${String(entries.length)} entries on disk are not in the bucket: seq ${missing.slice(0, 10).join(', ')}`);
  if (differs.length) fail(`${String(differs.length)} entries in the bucket don't match the disk (or can't be read): seq ${differs.slice(0, 10).join(', ')}`);
  if (!missing.length && !differs.length) pass(`every entry on disk (${String(entries.length)}) is in the bucket, matching`);

  // ── Object lock is on.
  try {
    const lock = await app.send(new GetObjectLockConfigurationCommand({ Bucket: SHRED_LEDGER_BUCKET }));
    if (lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled') pass(`object lock is enabled on ${SHRED_LEDGER_BUCKET}`);
    else fail(`object lock is not enabled on ${SHRED_LEDGER_BUCKET}`);
  } catch (e) {
    fail(`object lock on ${SHRED_LEDGER_BUCKET} can't be read: ${why(e)}`);
  }

  // ── Each copied entry is retained in COMPLIANCE mode for 10 years from its write.
  const short: number[] = [];
  let checked = 0;
  for (const e of entries) {
    const o = byKey.get(objectKey(ledgerId, dir, e));
    if (!o) continue;
    checked++;
    try {
      const r = await app.send(new GetObjectRetentionCommand({ Bucket: SHRED_LEDGER_BUCKET, Key: o.Key }));
      const until = r.Retention?.RetainUntilDate ? new Date(r.Retention.RetainUntilDate) : null;
      const from = new Date(o.LastModified ?? 0);
      from.setUTCFullYear(from.getUTCFullYear() + SHRED_LEDGER_RETENTION_YEARS);
      if (r.Retention?.Mode !== 'COMPLIANCE' || !until || until.getTime() < from.getTime() - DAY_MS) short.push(e.seq);
    } catch {
      short.push(e.seq);
    }
  }
  if (!checked) fail('no copied entry to check the retention of');
  else if (short.length) fail(`${String(short.length)} of ${String(checked)} entries are not retained in COMPLIANCE mode for ${String(SHRED_LEDGER_RETENTION_YEARS)} years: seq ${short.slice(0, 10).join(', ')}`);
  else pass(`every copied entry (${String(checked)}) is retained in COMPLIANCE mode for ${String(SHRED_LEDGER_RETENTION_YEARS)} years`);

  // ── The ledger identity is put-only, to its own bucket.
  const refused = async (what: string, run: () => Promise<unknown>, undo?: () => Promise<unknown>) => {
    try {
      await run();
      fail(`the ledger identity can ${what}`);
      if (undo) await undo().catch(() => undefined);
    } catch (e) {
      if (denied(e)) pass(`the ledger identity can't ${what}`);
      else fail(`the ledger identity's attempt to ${what} failed, but not as refused: ${why(e)}`);
    }
  };
  await refused(`list ${SHRED_LEDGER_BUCKET}`, () => led.send(new ListObjectsV2Command({ Bucket: SHRED_LEDGER_BUCKET, MaxKeys: 1 })));
  await refused(`read ${SHRED_LEDGER_BUCKET}`, () => led.send(new GetObjectCommand({ Bucket: SHRED_LEDGER_BUCKET, Key: genesisKey })));
  for (const Bucket of OTHER_BUCKETS) {
    await refused(`list ${Bucket}`, () => led.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })));
    // A probe key of its own: if the put is accepted (the FAIL), the app identity removes it again.
    const Key = `bucket-check/${randomUUID()}`;
    await refused(
      `write ${Bucket}`,
      () => led.send(new PutObjectCommand({ Bucket, Key, Body: '', ContentLength: 0 })),
      () => app.send(new DeleteObjectCommand({ Bucket, Key })),
    );
  }

  // ── Opt-in: a locked version can't be deleted, by either identity. It is the genesis's own version, so a FAIL here
  // has deleted real evidence (the disk keeps the authority).
  if (input.tryDelete) {
    try {
      const versions = await app.send(new ListObjectVersionsCommand({ Bucket: SHRED_LEDGER_BUCKET, Prefix: genesisKey }));
      const version = versions.Versions?.find((v) => v.Key === genesisKey)?.VersionId;
      if (!version) fail(`the genesis's version can't be found, so deletion wasn't tried`);
      else {
        for (const [who, client] of [
          ['app', app],
          ['ledger', led],
        ] as const) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: SHRED_LEDGER_BUCKET, Key: genesisKey, VersionId: version }));
          } catch {
            // Refused: what the lock is for. Whether the version survives is checked below either way.
          }
          const after = await app.send(new ListObjectVersionsCommand({ Bucket: SHRED_LEDGER_BUCKET, Prefix: genesisKey }));
          if (after.Versions?.some((v) => v.VersionId === version)) pass(`the ${who} identity can't delete a locked version`);
          else {
            fail(`the ${who} identity deleted a locked version (the genesis's)`);
            break;
          }
        }
      }
    } catch (e) {
      fail(`deletion couldn't be tried: ${why(e)}`);
    }
  }
  return lines;
}

/** The ledger on disk, at its generation of record, as recovery reads it (the primary). */
export function ledgerOnDisk(): BucketCheckInput['ledger'] {
  const record = generationOfRecord(PRIMARY);
  if (!record.ok) return { problem: record.problems.join('; ') };
  const copy = readCopy(PRIMARY, undefined, record.at);
  if (copy.state !== 'ok') return { problem: `the primary copy is ${copy.state}${copy.state === 'invalid' ? `: ${copy.problem}` : ''}` };
  return { ledgerId: copy.identity.ledgerId, dir: bucketDir(record.at), entries: copy.entries };
}

const FILES_HOST = `files.${STACK_DOMAIN}`;

/** An S3 client through the edge: the files host only, resolved to 127.0.0.1, its certificate verified against the edge CA. */
export function edgeClient(accessKeyId: string, secretAccessKey: string): S3Client {
  const lookup: AgentOptions['lookup'] = (hostname, options, cb) => {
    if (hostname !== FILES_HOST) {
      cb(new Error(`only ${FILES_HOST} is resolved here`), '', 4);
      return;
    }
    if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  return new S3Client({
    endpoint: `https://${FILES_HOST}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: { httpsAgent: new Agent({ ca: readFileSync(join(edgeDir(), 'edge-ca.crt')), lookup }) },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--try-delete')) {
    console.error('usage: pnpm stack:bucket-check [--try-delete]');
    process.exit(2);
  }
  let lines: string[] = [];
  let clients: S3Client[] = [];
  try {
    // Setting up: the secrets and the edge CA. Their errors name a file or a key name, except JSON's, which can quote
    // the file's content: that one is replaced.
    const s = loadSecrets();
    clients = [edgeClient(s.s3AccessKey, s.s3SecretKey), edgeClient(s.ledgerS3AccessKey, s.ledgerS3SecretKey)];
  } catch (e) {
    lines = [`FAIL the check couldn't start: ${e instanceof SyntaxError ? 'secrets.json is not valid JSON' : (e as Error).message}`];
  }
  const [app, ledgerIdentity] = clients;
  if (app && ledgerIdentity)
    try {
      lines = await bucketCheck({ ledger: ledgerOnDisk(), app, ledgerIdentity, tryDelete: args.includes('--try-delete') });
    } catch (e) {
      lines = [`FAIL the check stopped: ${why(e)}`];
    } finally {
      for (const c of clients) c.destroy();
    }
  for (const l of lines) console.log(`[stack:bucket-check] ${l}`);
  process.exit(lines.length && !lines.some((l) => l.startsWith('FAIL')) ? 0 : 1);
}
