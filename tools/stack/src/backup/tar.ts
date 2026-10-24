// Spec 0020 PR B1: the few tar streams a backup needs (shipped WAL out of the staging volume; the bucket's files, the
// stack directory's parts and the ledger snapshot into a set), in POSIX ustar: regular files and directories only,
// names up to 255 bytes. No dependency: the format is small and fixed, and nothing here follows links.
import { Readable } from 'node:stream';

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly mode?: number;
  readonly mtime?: Date;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function splitName(name: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  const cut = name.lastIndexOf('/', 155);
  if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) throw new Error(`tar: name too long: ${name}`);
  return { name: name.slice(cut + 1), prefix: name.slice(0, cut) };
}

export function header(e: { name: string; size: number; mode: number; mtime: Date; type: '0' | '5' }): Buffer {
  if (e.name.split('/').some((p) => p === '..') || e.name.startsWith('/')) throw new Error(`tar: unsafe name ${e.name}`);
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(e.name);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(e.mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(e.size, 12), 124, 'ascii');
  h.write(octal(Math.floor(e.mtime.getTime() / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum placeholder
  h.write(e.type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** A tar stream of the entries, in order, ending with the two zero blocks. */
export function tarStream(entries: Iterable<TarEntry> | AsyncIterable<TarEntry>): Readable {
  async function* gen() {
    for await (const e of entries) {
      yield header({ name: e.name, size: e.data.length, mode: e.mode ?? 0o600, mtime: e.mtime ?? new Date(0), type: '0' });
      yield e.data;
      yield padding(e.data.length);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(gen());
}

/**
 * Reads a tar stream's regular files, one at a time, each body buffered (bounded by `maxEntry`). Directories are
 * skipped; links and other types are refused. A stream that ends without the end blocks is refused (truncated).
 */
export async function* readTar(source: AsyncIterable<Buffer>, { maxEntry = 64 * 1024 * 1024 } = {}): AsyncGenerator<{ name: string; data: Buffer }> {
  let buf = Buffer.alloc(0);
  const it = source[Symbol.asyncIterator]();
  const need = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = Buffer.concat([buf, r.value]);
    }
    return true;
  };
  for (;;) {
    if (!(await need(BLOCK))) throw new Error('tar: truncated (no end blocks)');
    const h = buf.subarray(0, BLOCK);
    if (h.every((b) => b === 0)) return; // the end
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
    if (parseInt(h.toString('ascii', 148, 156).replace(/\0.*$/, '').trim(), 8) !== sum) throw new Error('tar: bad header checksum');
    const str = (a: number, b: number) => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    const prefix = str(345, 500);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxEntry) throw new Error(`tar: ${name}: size ${String(size)} refused`);
    const total = BLOCK + size + padding(size).length;
    if (!(await need(total))) throw new Error(`tar: ${name}: truncated`);
    const data = Buffer.from(buf.subarray(BLOCK, BLOCK + size));
    buf = buf.subarray(total);
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error(`tar: ${name}: type ${type} refused (regular files only)`);
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`tar: unsafe name ${name}`);
    yield { name, data };
  }
}
