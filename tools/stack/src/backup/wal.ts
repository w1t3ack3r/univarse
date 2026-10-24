// Spec 0020 D3, B-2: WAL shipping. PostgreSQL's archive_command copies each finished segment into the staging volume
// (inside the stack, unsealed: the container can't seal). This takes what is staged, compresses and seals each file,
// writes it durably to <destination>/wal/<timeline>/<name>.gz.seal, and only then removes the staged copies.
// A file already at its destination (shipped before a crash, or archived twice) is not written again; its staged
// copy is removed. Holds the registry lock, so it never races a backup's pruning or a deploy; when that lock is held,
// it ships nothing and says so (the next run ships it).
import type { KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { THIRD_PARTY } from '../config.js';
import { docker, type Runner } from '../docker.js';
import { realSetFs, WAL, writeSealed, type SetFs } from './set.js';
import { dockerStream, type StreamRunner } from './stream.js';
import { readTar } from './tar.js';

export const STAGING_VOLUME = 'univarse-stack-pg-wal-staging';
/** A WAL segment, a backup-history file, or a timeline history file: what archive_command stages. */
export const STAGED = /^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$/;
/** The same set as STAGED, in POSIX ERE for the container's grep (no `(?:`); wal.spec checks they agree. */
export const STAGED_ERE = '^([0-9A-F]{24}(\\.[0-9A-F]{8}\\.backup)?|[0-9A-F]{8}\\.history)$';
const PG_USER = '999:999';
const tool = (rw: boolean) => ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', PG_USER, '-v', `${STAGING_VOLUME}:/w${rw ? '' : ':ro'}`];

export interface WalDeps {
  /** The staged files that match STAGED, as a tar stream. */
  staged(): AsyncIterable<Buffer>;
  /** Removes staged files by name (each matches STAGED). */
  remove(names: readonly string[]): void;
  readonly fs: SetFs;
  exists(path: string): boolean;
}

export function realWalDeps(run: Runner = docker, stream: StreamRunner = dockerStream): WalDeps {
  return {
    // The list is filtered inside the container, so a file still being copied (`.part`) is never read half-written.
    staged: () =>
      stream([...tool(false), '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c', `cd /w && ls -1 | grep -E '${STAGED_ERE}' | tar --format=ustar -cf - -T -`]),
    remove: (names) => {
      for (const n of names) if (!STAGED.test(n)) throw new Error(`refusing to remove ${n}`);
      if (names.length) run([...tool(true), '--entrypoint', 'rm', THIRD_PARTY.postgres, '--', ...names.map((n) => `/w/${n}`)]);
    },
    fs: realSetFs,
    exists: existsSync,
  };
}

/** Where a staged file goes: its timeline's directory (a history file's name is its timeline). */
export function walPath(destination: string, name: string): string {
  if (!STAGED.test(name)) throw new Error(`not a WAL file: ${name}`);
  return join(destination, WAL, name.slice(0, 8), `${name}.gz.seal`);
}

export interface ShipResult {
  readonly shipped: number;
  readonly skipped: number;
  readonly lines: string[];
}

/** Ships everything staged now. The caller holds the registry lock. */
export async function shipWal(destination: string, recipient: KeyObject, deps: WalDeps): Promise<ShipResult> {
  let shipped = 0;
  let skipped = 0;
  const done: string[] = [];
  for await (const e of readTar(deps.staged())) {
    if (!STAGED.test(e.name)) throw new Error(`unexpected staged file ${e.name}`);
    const path = walPath(destination, e.name);
    if (deps.exists(path)) skipped++;
    else {
      deps.fs.mkdirp(join(destination, WAL, e.name.slice(0, 8)));
      await writeSealed(path, Readable.from([gzipSync(e.data)]), recipient, deps.fs);
      shipped++;
    }
    done.push(e.name);
  }
  // Removed only once every one of them is durable at the destination.
  deps.remove(done);
  const lines = [`WAL: ${String(shipped)} shipped${skipped ? `, ${String(skipped)} already at the destination` : ''}${done.length ? `, through ${String(done.filter((n) => n.length === 24).at(-1) ?? done.at(-1))}` : ''}`];
  return { shipped, skipped, lines };
}
