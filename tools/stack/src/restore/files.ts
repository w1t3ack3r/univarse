// Spec 0020 B2-8: the clean bucket's files go back through SeaweedFS's filer, from a one-shot container on the restore's
// own network (D9: no published port), and each is read back over the S3 API and hashed there. Only keys' positions and
// hashes come back to the host, never content. Verified while building (2026-10-26, SeaweedFS 4.48): an object written
// through the filer reads back over S3 with its key and bytes unchanged, spaces and non-ASCII names included.
//
// The host unseals `files.tar`, hashes each entry as it passes, and sends the container a tar of numbered entries
// (`o/<n>`) plus `index.tsv` (`<n>\t<encoded key>`), so no object key is ever a path on any file system. The container
// writes them into a labelled scratch volume (the restore's own: plaintext never touches the host's disk), PUTs each
// to the filer, GETs it over S3 with curl's own SigV4, and prints `<n>\t<put status>\t<get status>\t<sha256>`.
import { createHash } from 'node:crypto';
import { readTar, tarStream, type TarEntry } from '../backup/tar.js';

/**
 * An object key as a URL path, as SigV4 canonicalises it: each segment's bytes percent-encoded, except RFC 3986's
 * unreserved characters, `/` kept. (`encodeURIComponent` leaves `!'()*` alone, which SigV4 encodes.)
 */
export function s3Path(key: string): string {
  if (!key || key.startsWith('/') || key.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`an object key the restore won't write: ${JSON.stringify(key)}`);
  return key
    .split('/')
    .map((s) => [...Buffer.from(s, 'utf8')].map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) && b < 0x80 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join(''))
    .join('/');
}

export interface Sent {
  readonly key: string;
  readonly sha256: string;
}

/**
 * The container's input from the unsealed `files.tar`: numbered entries and their index, and the host's own hash of
 * each object, recorded as it streams by. `sent` is complete once the returned stream has been read to its end.
 */
export function scratchTar(files: AsyncIterable<Buffer>): { stream: NodeJS.ReadableStream; sent: Sent[] } {
  const sent: Sent[] = [];
  async function* entries(): AsyncGenerator<TarEntry> {
    const index: string[] = [];
    for await (const e of readTar(files, { maxEntry: 1024 * 1024 * 1024 })) {
      const n = String(sent.length + 1).padStart(7, '0');
      sent.push({ key: e.name, sha256: createHash('sha256').update(e.data).digest('hex') });
      index.push(`${n}\t${s3Path(e.name)}`);
      yield { name: `o/${n}`, data: e.data };
    }
    yield { name: 'index.tsv', data: Buffer.from(index.length ? `${index.join('\n')}\n` : '') };
  }
  return { stream: tarStream(entries()), sent };
}

/** The container's script: extract, then for each object PUT through the filer and GET over S3, hashed in the container. */
export const CONTAINER_SCRIPT = [
  'set -eu',
  'cd /scratch',
  'tar -x -f -',
  'F=http://seaweedfs:8888/buckets/uv-clean',
  'S3=http://seaweedfs:8333/uv-clean',
  'while IFS="$(printf "\\t")" read -r n path; do',
  '  put=$(curl -s -o /dev/null -w "%{http_code}" -X PUT --data-binary "@o/$n" "$F/$path")',
  '  get=$(curl -s -o "o/$n.back" -w "%{http_code}" --aws-sigv4 "aws:amz:us-east-1:s3" --user "$S3_ACCESS_KEY:$S3_SECRET_KEY" "$S3/$path")',
  '  sum=$(sha256sum "o/$n.back" | cut -d" " -f1)',
  '  rm -f "o/$n" "o/$n.back"',
  '  printf "%s\\t%s\\t%s\\t%s\\n" "$n" "$put" "$get" "$sum"',
  'done < index.tsv',
].join('\n');

/** The container's report against what was sent: every object written (201), read back (200), its hash equal. */
export function filesProblems(sent: readonly Sent[], report: string): string[] {
  const problems: string[] = [];
  const rows = new Map<number, string[]>();
  for (const line of report.split('\n').filter(Boolean)) {
    const cols = line.split('\t');
    rows.set(Number(cols[0]), cols);
  }
  sent.forEach((s, i) => {
    const r = rows.get(i + 1);
    // Keys can name people; the record says which object by its position only.
    const which = `object ${String(i + 1)} of ${String(sent.length)}`;
    if (!r) problems.push(`${which}: not restored`);
    else if (r[1] !== '201' && r[1] !== '200') problems.push(`${which}: the filer answered ${r[1] ?? '?'} to its write`);
    else if (r[2] !== '200') problems.push(`${which}: S3 answered ${r[2] ?? '?'} to its read`);
    else if (r[3] !== s.sha256) problems.push(`${which}: read back over S3, its SHA-256 differs`);
  });
  if (rows.size > sent.length) problems.push(`the container reported ${String(rows.size)} objects, ${String(sent.length)} were sent`);
  return problems;
}
