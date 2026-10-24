// Spec 0020 D3, B-3: the base backup. `pg_basebackup` runs as the `pgbackup` job (the pinned PostgreSQL image, on the
// `db` network, TLS verify-full, the REPLICATION-only role univarse_backup) and writes a tar to stdout, which the host
// seals as it streams: no unsealed copy touches the disk. `-X fetch` puts the WAL the backup needs inside it, so a set
// restores on its own; its manifest (SHA-256 per file) travels in the tar. `-v` reports the start point on stderr,
// which names the first WAL file the set needs: what pruning keeps the archive from (B-13).

/** pg_basebackup's own report of where its WAL starts. */
const START = /write-ahead log start point: ([0-9A-F]+)\/([0-9A-F]+) on timeline (\d+)/;
/** 16 MB segments (PostgreSQL's default, which the stack keeps): 256 segments per 4 GB "xlogid". */
const SEGMENT = 16 * 1024 * 1024;
const PER_ID = 0x1_0000_0000 / SEGMENT;

/** The WAL file holding `lsn` (`hi/lo` in hex) on `timeline`, as PostgreSQL names it. */
export function walFileName(lsn: string, timeline: number): string {
  const m = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn);
  if (!m || !Number.isSafeInteger(timeline) || timeline < 1) throw new Error(`bad LSN ${lsn} or timeline ${String(timeline)}`);
  const segno = (BigInt(`0x${m[1] ?? '0'}`) * 0x1_0000_0000n + BigInt(`0x${m[2] ?? '0'}`)) / BigInt(SEGMENT);
  const hex = (n: bigint | number) => n.toString(16).toUpperCase().padStart(8, '0');
  return `${hex(timeline)}${hex(segno / BigInt(PER_ID))}${hex(segno % BigInt(PER_ID))}`;
}

/** The start point from pg_basebackup's stderr; throws when it isn't there (the backup can't be indexed). */
export function startOf(stderr: string): { lsn: string; timeline: number; startWal: string } {
  const m = START.exec(stderr);
  if (!m) throw new Error("pg_basebackup did not report its WAL start point: the set can't be indexed");
  const lsn = `${m[1] ?? ''}/${m[2] ?? ''}`;
  const timeline = Number(m[3]);
  return { lsn, timeline, startWal: walFileName(lsn, timeline) };
}

/** The job's arguments (the image's entrypoint is pg_basebackup; the connection comes from backup.env). */
export const BASEBACKUP_ARGS = ['-v', '-D', '-', '-F', 't', '-X', 'fetch', '-c', 'fast', '--manifest-checksums=SHA256', '--no-sync'] as const;
