// Spec 0020 B-6: a backup set on disk.
//   <destination>/sets/<setId>/<artifact>.seal   each artifact sealed as it streams (D5); never in clear on disk
//   <destination>/sets/<setId>/manifest.seal     everything D2 and BK3 name, sealed
//   <destination>/sets/<setId>/index.json        clear, written last: the set's completion marker
//   <destination>/wal/<timeline>/<segment>.gz.seal   shipped WAL (B-2)
// "Durable" is A2's meaning: written, fsync'd, then read back and its SHA-256 found equal to what was written. The
// clear index holds no tenant name, no count and no secret: only what pruning and `status` need without the key.
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fingerprint, sealStream } from './seal.js';

export const SETS = 'sets';
export const WAL = 'wal';
export const INDEX = 'index.json';
export const MANIFEST = 'manifest.seal';

/** A set id sorts by time: `20261024T101500Z-1a2b`. */
export function newSetId(now: Date): string {
  const t = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${t}-${randomBytes(2).toString('hex')}`;
}
export const SET_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export interface ArtifactRecord {
  readonly name: string;
  /** Of the plaintext: in the sealed manifest only. */
  readonly plainSha256: string;
  readonly plainSize: number;
  /** Of the sealed bytes on disk: in the clear index too, so a set's integrity is checked without the key. */
  readonly sealedSha256: string;
  readonly sealedSize: number;
}

export interface SetIndex {
  readonly format: 'univarse-backup-set-v1';
  readonly setId: string;
  readonly createdAt: string;
  readonly complete: true;
  /** B-3: the first WAL file this set's base backup needs, and its timeline: what pruning keeps the WAL from. */
  readonly startWal: string;
  readonly timeline: number;
  readonly keyFingerprint: string;
  readonly files: readonly { readonly name: string; readonly size: number; readonly sha256: string }[];
}

/** The I/O a set needs: injectable, so a test can count the fsyncs and make a read-back differ (BK13's discipline). */
export interface SetFs {
  open(path: string): number;
  write(fd: number, data: Buffer): void;
  fsync(fd: number): void;
  close(fd: number): void;
  readHash(path: string): Promise<{ sha256: string; size: number }>;
  rename(from: string, to: string): void;
  mkdirp(path: string): void;
  list(path: string): string[];
  read(path: string): Buffer | null;
  remove(path: string): void;
}

export const realSetFs: SetFs = {
  open: (p) => openSync(p, 'wx', 0o600),
  write: (fd, data) => {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off);
  },
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  readHash: async (p) => {
    const h = createHash('sha256');
    let size = 0;
    for await (const b of createReadStream(p) as AsyncIterable<Buffer>) {
      h.update(b);
      size += b.length;
    }
    return { sha256: h.digest('hex'), size };
  },
  rename: (a, b) => renameSync(a, b),
  mkdirp: (p) => void mkdirSync(p, { recursive: true, mode: 0o700 }),
  list: (p) => (existsSync(p) ? readdirSync(p) : []),
  read: (p) => (existsSync(p) ? readFileSync(p) : null),
  remove: (p) => rmSync(p, { recursive: true, force: true }),
};

/** A Writable into a new file (exclusive), fsync'd before it finishes. */
function fileSink(path: string, fs: SetFs): Writable {
  const fd = fs.open(path);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      fs.close(fd);
    }
  };
  return new Writable({
    write(chunk: Buffer, _e, done) {
      try {
        fs.write(fd, chunk);
        done();
      } catch (e) {
        done(e as Error);
      }
    },
    final(done) {
      try {
        fs.fsync(fd);
        close();
        done();
      } catch (e) {
        done(e as Error);
      }
    },
    destroy(err, done) {
      close();
      done(err);
    },
  });
}

/** A pass-through that hashes and counts what flows. */
function meter(): Transform & { result(): { sha256: string; size: number } } {
  const h = createHash('sha256');
  let size = 0;
  const t = new Transform({
    transform(chunk: Buffer, _e, done) {
      h.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  }) as Transform & { result(): { sha256: string; size: number } };
  let digest: string | null = null;
  t.result = () => ({ sha256: (digest ??= h.digest('hex')), size });
  return t;
}

/**
 * Seals `source` into `path`, through a temporary name, then renames it in only once it is durable: fsync'd, read back,
 * and its SHA-256 equal to the bytes written. A failure leaves no file under the final name.
 */
export async function writeSealed(path: string, source: Readable | AsyncIterable<Buffer>, recipient: KeyObject, fs: SetFs = realSetFs): Promise<Omit<ArtifactRecord, 'name'>> {
  const tmp = `${path}.partial`;
  const plain = meter();
  const sealed = meter();
  try {
    await pipeline(Readable.from(source), plain, sealStream(recipient), sealed, fileSink(tmp, fs));
    const back = await fs.readHash(tmp);
    const wrote = sealed.result();
    if (back.sha256 !== wrote.sha256 || back.size !== wrote.size) throw new Error(`${path}: read back differs from what was written (not durable)`);
    fs.rename(tmp, path);
    return { plainSha256: plain.result().sha256, plainSize: plain.result().size, sealedSha256: wrote.sha256, sealedSize: wrote.size };
  } catch (e) {
    fs.remove(tmp);
    throw e;
  }
}

/** Writes a small clear file durably: through a temporary name, fsync'd, read back byte for byte, then renamed in. */
export async function writeClearDurable(path: string, data: Buffer, fs: SetFs = realSetFs): Promise<void> {
  const tmp = `${path}.partial`;
  try {
    const fd = fs.open(tmp);
    try {
      fs.write(fd, data);
      fs.fsync(fd);
    } finally {
      fs.close(fd);
    }
    const back = await fs.readHash(tmp);
    if (back.sha256 !== createHash('sha256').update(data).digest('hex')) throw new Error(`${path}: read back differs from what was written (not durable)`);
    fs.rename(tmp, path);
  } catch (e) {
    fs.remove(tmp);
    throw e;
  }
}

/** One set being written. Artifacts first, then the sealed manifest, then the clear index, which completes it. */
export class SetWriter {
  readonly dir: string;
  private readonly artifacts: ArtifactRecord[] = [];
  private done = false;

  constructor(
    readonly destination: string,
    readonly setId: string,
    private readonly recipient: KeyObject,
    private readonly fs: SetFs = realSetFs,
  ) {
    if (!SET_ID.test(setId)) throw new Error(`bad set id ${setId}`);
    this.dir = join(destination, SETS, setId);
    fs.mkdirp(this.dir);
  }

  async add(name: string, source: Readable | AsyncIterable<Buffer>): Promise<ArtifactRecord> {
    if (this.done) throw new Error('the set is complete');
    if (!/^[a-z0-9-]+\.[a-z0-9.]+$/.test(name) || name === MANIFEST || name === INDEX) throw new Error(`bad artifact name ${name}`);
    const r = { name: `${name}.seal`, ...(await writeSealed(join(this.dir, `${name}.seal`), source, this.recipient, this.fs)) };
    this.artifacts.push(r);
    return r;
  }

  get records(): readonly ArtifactRecord[] {
    return this.artifacts;
  }

  /** The manifest (sealed), then the index (clear, last). Only now is the set complete. */
  async complete(manifest: Record<string, unknown>, index: { createdAt: Date; startWal: string; timeline: number }): Promise<SetIndex> {
    if (this.done) throw new Error('the set is complete');
    const body = Buffer.from(`${JSON.stringify({ ...manifest, setId: this.setId, artifacts: this.artifacts }, null, 2)}\n`);
    const m = await writeSealed(join(this.dir, MANIFEST), Readable.from([body]), this.recipient, this.fs);
    const files = [...this.artifacts.map((a) => ({ name: a.name, size: a.sealedSize, sha256: a.sealedSha256 })), { name: MANIFEST, size: m.sealedSize, sha256: m.sealedSha256 }];
    if (!/^[0-9A-F]{24}$/.test(index.startWal)) throw new Error(`bad start WAL file ${index.startWal}`);
    const idx: SetIndex = {
      format: 'univarse-backup-set-v1',
      setId: this.setId,
      createdAt: index.createdAt.toISOString(),
      complete: true,
      startWal: index.startWal,
      timeline: index.timeline,
      keyFingerprint: fingerprint(this.recipient).toString('hex'),
      files,
    };
    await writeClearDurable(join(this.dir, INDEX), Buffer.from(`${JSON.stringify(idx, null, 2)}\n`), this.fs);
    this.done = true;
    return idx;
  }
}

export interface SetOnDisk {
  readonly setId: string;
  readonly createdAt: Date;
  /** Null: no index, so the set is incomplete and ignored (B-6). */
  readonly index: SetIndex | null;
}

/** Every set directory under a destination, complete or not. A set without a readable index is incomplete. */
export function listSets(destination: string, fs: SetFs = realSetFs): SetOnDisk[] {
  const out: SetOnDisk[] = [];
  for (const id of fs.list(join(destination, SETS))) {
    if (!SET_ID.test(id)) continue;
    const t = id.slice(0, 16);
    const createdAt = new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`);
    let index: SetIndex | null = null;
    try {
      const raw = fs.read(join(destination, SETS, id, INDEX));
      const parsed = raw ? (JSON.parse(raw.toString('utf8')) as SetIndex) : null;
      if (parsed?.format === 'univarse-backup-set-v1' && parsed.complete && parsed.setId === id) index = parsed;
    } catch {
      index = null;
    }
    out.push({ setId: id, createdAt, index });
  }
  return out.sort((a, b) => a.setId.localeCompare(b.setId));
}

/** B-6: checks a complete set's files against its clear index, without the key: present, same size, same SHA-256. */
export async function verifySealedFiles(destination: string, index: SetIndex, fs: SetFs = realSetFs): Promise<string[]> {
  const problems: string[] = [];
  for (const f of index.files) {
    const p = join(destination, SETS, index.setId, f.name);
    try {
      const h = await fs.readHash(p);
      if (h.size !== f.size || h.sha256 !== f.sha256) problems.push(`${index.setId}/${f.name}: differs from its index`);
    } catch {
      problems.push(`${index.setId}/${f.name}: missing or unreadable`);
    }
  }
  return problems;
}
