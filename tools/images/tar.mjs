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
export function tarParser(onEntry, { wantData = () => false } = {}) {
  let buf = Buffer.alloc(0);
  let skip = 0; // bytes (padded to 512) still to consume for the current entry
  let paxPath = null;
  let paxLink = null;
  let gnuLong = null;
  let gnuLongLink = null;
  let pending = null; // { kind: 'x' | 'L' | 'K' | 'file', size, data: Buffer[], entry? }
  const oct = (b) => {
    const s = b.toString('latin1').replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) : 0;
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
            if (pending.kind === 'x') {
              const text = data.toString('utf8');
              const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
              if (m) paxPath = m[1];
              const l = /(?:^|\n)\d+ linkpath=([^\n]*)\n/.exec(text);
              if (l) paxLink = l[1];
            } else if (pending.kind === 'L') gnuLong = data.toString('utf8').replace(/\0+$/, '');
            else if (pending.kind === 'K') gnuLongLink = data.toString('utf8').replace(/\0+$/, '');
            else onEntry({ ...pending.entry, data });
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
        if (flag === 'x' || flag === 'L' || flag === 'K') {
          pending = { kind: flag, size, data: [] };
          skip = padded;
          continue;
        }
        if (flag === 'g') {
          skip = padded;
          continue;
        }
        const path = paxPath ?? gnuLong ?? (prefix ? `${prefix}/${name}` : name);
        const link =
          paxLink ?? gnuLongLink ?? h.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
        paxPath = null;
        paxLink = null;
        gnuLong = null;
        gnuLongLink = null;
        const type = TYPES[flag] ?? 'other';
        const entry = {
          path,
          type,
          size,
          uid: oct(h.subarray(108, 116)),
          gid: oct(h.subarray(116, 124)),
          mode: oct(h.subarray(100, 108)),
        };
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
