// Spec 0020 B2-6 (steps 1 and 3): a set is opened only after every sealed file matches its clear index, and every
// artifact is unsealed as a stream, hashed as it flows, and refused at its end if its plaintext's SHA-256 or size
// differs from the manifest's. Nothing unsealed is written to the host's disk here: the stream goes where its consumer
// sends it (a Docker volume, or memory for the small parts).
import { createHash, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { unsealStream } from '../backup/seal.js';
import { listSets, MANIFEST, SETS, verifySealedFiles, type ArtifactRecord, type SetIndex } from '../backup/set.js';
import { readTar } from '../backup/tar.js';

export class ArtifactMismatch extends Error {}

/** The plaintext of `<set>/<name>`, checked against its record once the stream ends. */
export function openArtifact(path: string, record: Pick<ArtifactRecord, 'name' | 'plainSha256' | 'plainSize'>, key: KeyObject): Readable {
  const h = createHash('sha256');
  let size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _e, done) {
      h.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
    flush(done) {
      const got = h.digest('hex');
      if (got !== record.plainSha256 || size !== record.plainSize) done(new ArtifactMismatch(`${record.name}: its plaintext differs from the manifest (SHA-256 or size): refused`));
      else done();
    },
  });
  const sealed = createReadStream(path);
  const out = sealed.pipe(unsealStream(key));
  sealed.on('error', (e) => out.destroy(e));
  out.on('error', (e) => check.destroy(e));
  return out.pipe(check);
}

/** All of a small artifact, in memory (the manifest, `stack.tar`, `ledger.tar`). */
export async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of stream) parts.push(b);
  return Buffer.concat(parts);
}

export interface Manifest {
  /** Checked on opening: a manifest of another format is refused. */
  readonly format: string;
  readonly setId: string;
  readonly createdAt: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly deployed: Readonly<Record<string, string>>;
  readonly postgres: { readonly startLsn: string; readonly timeline: number; readonly startWal: string };
  readonly facts: unknown;
  readonly ledger: { readonly ledgerId: string; readonly generation: number; readonly seq: number; readonly hash: string };
  readonly artifacts: readonly ArtifactRecord[];
}

export interface OpenedSet {
  readonly index: SetIndex;
  readonly manifest: Manifest;
  readonly dir: string;
  /** The artifact's plaintext stream, checked against the manifest. */
  artifact(name: string): Readable;
  /** A small tar artifact's files, in memory. */
  files(name: string): Promise<{ name: string; data: Buffer }[]>;
}

/**
 * Step 1's set checks, then step 3's manifest: the set is complete, every sealed file matches its index (without the
 * key), the manifest opens with the key and names this set, and its artifacts are exactly the index's.
 */
export async function openSet(destination: string, setId: string | undefined, key: KeyObject): Promise<{ ok: true; set: OpenedSet } | { ok: false; problems: string[] }> {
  const all = listSets(destination);
  const chosen = setId === undefined ? all.filter((s) => s.index).at(-1) : all.find((s) => s.setId === setId);
  if (!chosen) return { ok: false, problems: [setId === undefined ? `no complete backup set in ${destination}` : `no set ${setId} in ${destination}`] };
  const index = chosen.index;
  if (!index) return { ok: false, problems: [`set ${chosen.setId} is incomplete (no index): it can't be restored`] };
  const problems = await verifySealedFiles(destination, index);
  if (problems.length) return { ok: false, problems };
  const dir = join(destination, SETS, index.setId);
  const manifestFile = index.files.find((f) => f.name === MANIFEST);
  if (!manifestFile) return { ok: false, problems: [`set ${index.setId} has no manifest in its index`] };
  let manifest: Manifest;
  try {
    // The manifest's own plaintext hash isn't recorded anywhere (it holds the others); its sealed hash was checked.
    const sealed = createReadStream(join(dir, MANIFEST)).pipe(unsealStream(key));
    manifest = JSON.parse((await readAll(sealed)).toString('utf8')) as Manifest;
  } catch (e) {
    return { ok: false, problems: [`set ${index.setId}: its manifest does not open with this key: ${(e as Error).message}`] };
  }
  if (manifest.format !== 'univarse-backup-manifest-v1' || manifest.setId !== index.setId) return { ok: false, problems: [`set ${index.setId}: its manifest names another set or format`] };
  const sealedNames = index.files.map((f) => f.name).filter((n) => n !== MANIFEST).sort();
  const manifestNames = manifest.artifacts.map((a) => a.name).sort();
  if (JSON.stringify(sealedNames) !== JSON.stringify(manifestNames)) return { ok: false, problems: [`set ${index.setId}: its index and its manifest list different artifacts`] };
  const record = (name: string) => {
    const r = manifest.artifacts.find((a) => a.name === `${name}.seal`);
    if (!r) throw new Error(`set ${index.setId} has no ${name}`);
    return r;
  };
  const set: OpenedSet = {
    index,
    manifest,
    dir,
    artifact: (name) => openArtifact(join(dir, `${name}.seal`), record(name), key),
    files: async (name) => {
      const out: { name: string; data: Buffer }[] = [];
      for await (const e of readTar(set.artifact(name))) out.push(e);
      return out;
    },
  };
  return { ok: true, set };
}

