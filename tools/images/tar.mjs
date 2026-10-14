// Spec 0013: a minimal streaming tar reader (ustar, pax, GNU long names), shared by the image inspector and the
// local release. No tar binary needed, so it behaves the same on Windows and Linux.
import { createReadStream } from 'node:fs';

/**
 * Calls onEntry({ path, type, size, uid, gid, mode, link?, data? }) for every entry. `type` is 'file', 'dir',
 * 'symlink', 'hardlink', 'char', 'block', 'fifo' or 'other': an unrecognised type flag is never passed off as a file.
 * `link` is a symlink's or hardlink's target (from the header, a pax `linkpath`, or a GNU long link). `data` (a
 * Buffer) is collected only for files where wantData(path) is true; onEntry is then called once the data is complete.
 */
const TYPES = {
  0: 'file',
  7: 'file',
  1: 'hardlink',
  2: 'symlink',
  3: 'char',
  4: 'block',
  5: 'dir',
  6: 'fifo',
};
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decodes a pax extended header (POSIX.1-2001): records `<len> <key>=<value>\n`, where `<len>` is the record's total
 * length in BYTES, its own digits included. Records are taken strictly by their declared lengths, so a value may hold
 * newlines, or text that looks like another record, and none of it is ever read as metadata. Throws on anything
 * malformed: a non-decimal or zero-padded length, a record overrunning the header, a missing space, `=` or final
 * newline, an empty key, a repeated key, or invalid UTF-8.
 */
export function parsePax(data) {
  const out = new Map();
  let i = 0;
  while (i < data.length) {
    let j = i;
    while (j < data.length && data[j] >= 0x30 && data[j] <= 0x39) j++;
    if (j === i || data[j] !== 0x20) throw new Error(`pax: malformed record length at byte ${i}`);
    const digits = data.subarray(i, j).toString('latin1');
    if (digits.length > 1 && digits.startsWith('0'))
      throw new Error(`pax: zero-padded record length at byte ${i}`);
    const len = Number(digits);
    if (!Number.isSafeInteger(len) || len <= j - i + 1 || i + len > data.length)
      throw new Error(
        `pax: the record at byte ${i} declares ${digits} bytes, which overruns the header`,
      );
    if (data[i + len - 1] !== 0x0a)
      throw new Error(`pax: the record at byte ${i} doesn't end in a newline`);
    const body = data.subarray(j + 1, i + len - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) throw new Error(`pax: the record at byte ${i} has no key`);
    const key = utf8.decode(body.subarray(0, eq));
    if (out.has(key)) throw new Error(`pax: key ${key} is repeated`);
    out.set(key, utf8.decode(body.subarray(eq + 1)));
    i += len;
  }
  return out;
}

/** Pax keys that change how an entry is framed or owned; a global header may not set any of them. */
const PAX_STRUCTURAL = ['path', 'linkpath', 'size', 'uid', 'gid'];
const decimal = (key, v) => {
  if (!/^(0|[1-9]\d*)$/.test(v))
    throw new Error(`pax: ${key}=${JSON.stringify(v)} isn't a decimal number`);
  return Number(v);
};

export function tarParser(onEntry, { wantData = () => false } = {}) {
  let buf = Buffer.alloc(0);
  let skip = 0; // bytes (padded to 512) still to consume for the current entry
  let pax = null; // the pending extended header's records, applied to the next entry only
  let gnuLong = null;
  let gnuLongLink = null;
  let pending = null; // { kind: 'x' | 'g' | 'L' | 'K' | 'file', size, data: Buffer[], entry? }
  const oct = (b) => {
    const s = b.toString('latin1').replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) : 0;
  };
  /** A metadata entry's contents, applied once complete. */
  const finishMeta = (kind, data) => {
    if (kind === 'x') {
      pax = parsePax(data);
      // A size override would change where the data ends; nothing UniVarse inspects needs one.
      if (pax.has('size')) throw new Error('pax: a size override is not supported');
    } else if (kind === 'g') {
      const g = parsePax(data);
      for (const k of PAX_STRUCTURAL)
        if (g.has(k)) throw new Error(`pax: a global header setting ${k} is not supported`);
    } else if (kind === 'L') gnuLong = data.toString('utf8').replace(/\0+$/, '');
    else if (kind === 'K') gnuLongLink = data.toString('utf8').replace(/\0+$/, '');
  };
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          if (pending) pending.data.push(buf.subarray(0, n));
          buf = buf.subarray(n);
          skip -= n;
          if (skip > 0) return;
          if (pending) {
            const data = Buffer.concat(pending.data).subarray(0, pending.size);
            if (pending.kind === 'file') onEntry({ ...pending.entry, data });
            else finishMeta(pending.kind, data);
            pending = null;
          }
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) continue;
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const size = oct(h.subarray(124, 136));
        const flag = String.fromCharCode(h[156] || 48);
        const padded = Math.ceil(size / 512) * 512;
        if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
          if (flag === 'x' && pax) throw new Error('pax: two extended headers for one entry');
          // A zero-length metadata entry has no data blocks to wait for: apply it now.
          if (size === 0) finishMeta(flag, Buffer.alloc(0));
          else pending = { kind: flag, size, data: [] };
          skip = padded;
          continue;
        }
        const path = pax?.get('path') ?? gnuLong ?? (prefix ? `${prefix}/${name}` : name);
        const link =
          pax?.get('linkpath') ??
          gnuLongLink ??
          h.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
        const uid = pax?.has('uid') ? decimal('uid', pax.get('uid')) : oct(h.subarray(108, 116));
        const gid = pax?.has('gid') ? decimal('gid', pax.get('gid')) : oct(h.subarray(116, 124));
        pax = null;
        gnuLong = null;
        gnuLongLink = null;
        const type = TYPES[flag] ?? 'other';
        const entry = { path, type, size, uid, gid, mode: oct(h.subarray(100, 108)) };
        if (type === 'symlink' || type === 'hardlink') entry.link = link;
        if (type === 'file' && size > 0 && wantData(path))
          pending = { kind: 'file', size, data: [], entry };
        else onEntry(entry);
        skip = padded;
      }
    },
  };
}

/** Reads one file's contents out of a tar file on disk. Resolves null when it isn't there. */
export function readFromTar(tarPath, wanted) {
  return new Promise((resolve, reject) => {
    let found = null;
    const parser = tarParser(
      (e) => {
        if (e.data && e.path.replace(/^\.?\//, '') === wanted) found = e.data;
      },
      { wantData: (p) => p.replace(/^\.?\//, '') === wanted },
    );
    createReadStream(tarPath)
      .on('data', (c) => parser.push(c))
      .on('error', reject)
      .on('end', () => resolve(found));
  });
}
