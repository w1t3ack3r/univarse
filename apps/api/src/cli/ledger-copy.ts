// Spec 0020 D7 (A2-10): the shred ledger's extra copy in the stack's object-locked bucket. Evidence only, never relied
// on for durability: the host-side ledger outside the stack is the authority. Each entry is one object, retained in
// COMPLIANCE mode for 10 years, written under the bucket's own put-only identity (never the app's).
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const SHRED_LEDGER_BUCKET = 'uv-shred-ledger';
export const SHRED_LEDGER_RETENTION_YEARS = 10;

interface LedgerEntryLine {
  readonly seq: number;
  readonly hash: string;
}

/** `<ledgerId>/<generation>/<seq, zero-padded>-<hash>.json`: ordered, and unique to the entry's content. */
export const objectKey = (ledgerId: string, generation: string, e: LedgerEntryLine) =>
  `${ledgerId}/${generation}/${String(e.seq).padStart(10, '0')}-${e.hash}.json`;

/**
 * Copies each line (an entry, canonical JSON). The host sends only the entries it hasn't copied yet (its own record);
 * a repeat after a lost record only adds an object version. Returns how many were written; throws on the first
 * failure (the host reports it and carries on: the copy never blocks the protocol). The identity can write, not read.
 */
export async function copyToBucket(
  opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; ledgerId: string; generation: string; now?: Date },
  lines: readonly string[],
): Promise<number> {
  if (!/^[0-9a-f-]{36}$/.test(opts.ledgerId) || !/^gen-\d{4}$/.test(opts.generation)) throw new Error('bad ledger id or generation');
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const retainUntil = new Date(opts.now ?? new Date());
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + SHRED_LEDGER_RETENTION_YEARS);
  let written = 0;
  try {
    for (const line of lines) {
      const e = JSON.parse(line) as LedgerEntryLine;
      if (!Number.isInteger(e.seq) || !/^[0-9a-f]{64}$/.test(e.hash)) throw new Error('not a ledger entry');
      const Key = objectKey(opts.ledgerId, opts.generation, e);
      await s3.send(
        new PutObjectCommand({
          Bucket: SHRED_LEDGER_BUCKET,
          Key,
          Body: `${line}\n`,
          ContentType: 'application/json',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      written++;
    }
  } finally {
    s3.destroy();
  }
  return written;
}
