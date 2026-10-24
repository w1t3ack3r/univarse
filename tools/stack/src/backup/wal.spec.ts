// Spec 0020 B-2: shipped WAL is sealed and durable before its staged copy is removed; a file already shipped is not
// written twice; a half-copied file is never read; nothing is removed when shipping fails.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Runner } from '../docker.js';
import { unseal } from './seal.js';
import { realSetFs } from './set.js';
import type { StreamRunner } from './stream.js';
import { realWalDeps, shipWal, STAGED, STAGED_ERE, walPath, type WalDeps } from './wal.js';

const keys = () => {
  const k = generateKeyPairSync('x25519');
  return { pub: k.publicKey, priv: k.privateKey };
};
const SEG1 = '000000010000000000000001';
const SEG2 = '000000010000000000000002';
const NAMES = [SEG1, SEG2, '000000010000000000000002.00000028.backup', '00000002.history'];

/** The container's script, run by the local shell against `dir` in place of the volume. */
function localStream(dir: string): { stream: StreamRunner; args: () => readonly string[] } {
  let seen: readonly string[] = [];
  const stream: StreamRunner = (args) => {
    seen = args;
    const script = (args.at(-1) ?? '').replace('cd /w', `cd '${dir}'`);
    return {
      async *[Symbol.asyncIterator]() {
        const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] });
        for await (const b of child.stdout as AsyncIterable<Buffer>) yield b;
      },
    };
  };
  return { stream, args: () => seen };
}

function staging(files: Record<string, Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), 'uv-staged-'));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  return dir;
}

function localDeps(dir: string, removed: string[][]): WalDeps {
  const { stream } = localStream(dir);
  const run: Runner = (args) => {
    removed.push(args.slice(args.indexOf('--') + 1).map((p) => p.replace('/w/', '')));
    return { status: 0, stdout: '', stderr: '' };
  };
  return realWalDeps(run, stream);
}

describe('STAGED_ERE', () => {
  it('matches exactly what STAGED matches, through the real grep', async () => {
    const candidates = [...NAMES, `${SEG1}.part`, 'archive_status', '0000000100000000000000G1', `${SEG1}.00000028.backup.part`, '00000002.history.part', 'readme', `x${SEG1}`];
    const out: Buffer[] = [];
    const child = spawn('grep', ['-E', STAGED_ERE], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.end(`${candidates.join('\n')}\n`);
    for await (const b of child.stdout as AsyncIterable<Buffer>) out.push(b);
    expect(Buffer.concat(out).toString().trim().split('\n')).toEqual(candidates.filter((c) => STAGED.test(c)));
    expect(candidates.filter((c) => STAGED.test(c))).toEqual(NAMES);
  });
});

describe('shipWal', () => {
  it('seals and ships every staged file, skips a half-copied one, then removes what it shipped', async () => {
    const { pub, priv } = keys();
    const files = Object.fromEntries(NAMES.map((n) => [n, randomBytes(n.length === 24 ? 100_000 : 100)]));
    const dir = staging({ ...files, [`${SEG2.replace('2', '3')}.part`]: Buffer.from('being copied') });
    const dest = mkdtempSync(join(tmpdir(), 'uv-dest-'));
    const removed: string[][] = [];
    const r = await shipWal(dest, pub, localDeps(dir, removed));
    expect(r.shipped).toBe(4);
    for (const n of NAMES) {
      const sealed = readFileSync(walPath(dest, n));
      expect(gunzipSync(await unseal(sealed, priv)).equals(files[n] as Buffer)).toBe(true);
    }
    expect(readdirSync(join(dest, 'wal')).sort()).toEqual(['00000001', '00000002']);
    expect(removed).toEqual([NAMES]);
    expect(r.lines).toEqual([`WAL: 4 shipped, through ${SEG2}`]);
  });

  it('a file already at the destination is not written again, and its staged copy is removed', async () => {
    const { pub } = keys();
    const dir = staging({ [SEG1]: Buffer.from('a'), [SEG2]: Buffer.from('b') });
    const dest = mkdtempSync(join(tmpdir(), 'uv-dest-'));
    mkdirSync(join(dest, 'wal', '00000001'), { recursive: true });
    writeFileSync(walPath(dest, SEG1), 'shipped before the crash');
    const removed: string[][] = [];
    const r = await shipWal(dest, pub, localDeps(dir, removed));
    expect(r).toMatchObject({ shipped: 1, skipped: 1 });
    expect(readFileSync(walPath(dest, SEG1), 'utf8')).toBe('shipped before the crash');
    expect(removed).toEqual([[SEG1, SEG2]]);
  });

  it('removes nothing when a write fails part-way, and leaves no partial file', async () => {
    const { pub } = keys();
    const dir = staging({ [SEG1]: Buffer.from('a'), [SEG2]: Buffer.from('b') });
    const dest = mkdtempSync(join(tmpdir(), 'uv-dest-'));
    const removed: string[][] = [];
    const deps = localDeps(dir, removed);
    let writes = 0;
    const failing: WalDeps = { ...deps, fs: { ...realSetFs, open: (p) => (++writes === 2 ? (() => { throw new Error('disk full'); })() : realSetFs.open(p)) } };
    await expect(shipWal(dest, pub, failing)).rejects.toThrow(/disk full/);
    expect(removed).toEqual([]);
    expect(existsSync(walPath(dest, SEG1))).toBe(true);
    expect(readdirSync(join(dest, 'wal', '00000001'))).toEqual([`${SEG1}.gz.seal`]);
  });

  it('removes nothing when the staged stream fails (the container exited non-zero)', async () => {
    const { pub } = keys();
    const dest = mkdtempSync(join(tmpdir(), 'uv-dest-'));
    const removed: string[] = [];
    const deps: WalDeps = {
      staged: () => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield Buffer.alloc(0);
          throw new Error('docker run exited 1');
        },
      }),
      remove: (n) => removed.push(...n),
      fs: realSetFs,
      exists: existsSync,
    };
    await expect(shipWal(dest, pub, deps)).rejects.toThrow(/exited 1/);
    expect(removed).toEqual([]);
  });

  it('nothing staged: nothing shipped, nothing removed', async () => {
    const { pub } = keys();
    const removed: string[][] = [];
    const r = await shipWal(mkdtempSync(join(tmpdir(), 'uv-dest-')), pub, localDeps(staging({}), removed));
    expect(r.shipped).toBe(0);
    expect(removed).toEqual([]);
  });

  it('the containers have no network, drop every capability, and mount the staging volume read-only to read it', () => {
    const { stream, args } = localStream('/nonexistent');
    let rmArgs: readonly string[] = [];
    const deps = realWalDeps((a) => {
      rmArgs = a;
      return { status: 0, stdout: '', stderr: '' };
    }, stream);
    deps.staged();
    deps.remove([SEG1]);
    for (const a of [args(), rmArgs]) {
      expect(a).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '999:999']));
    }
    expect(args()).toContain('univarse-stack-pg-wal-staging:/w:ro');
    expect(rmArgs).toContain('univarse-stack-pg-wal-staging:/w');
    expect(() => deps.remove(['../../etc/passwd'])).toThrow(/refusing/);
  });
});
