// The tar reader keeps link targets and exact entry kinds (spec 0017 PB10: links are part of the inventory).
// Run: node --test tools/images/tar.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tarParser } from './tar.mjs';

/** One ustar header block (the reader doesn't verify checksums). */
function header(name, flag, { size = 0, linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write(flag, 156, 'latin1');
  h.write(linkname, 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  return h;
}
const block = (s) => {
  const b = Buffer.alloc(Math.ceil(Buffer.byteLength(s) / 512) * 512);
  b.write(s, 0, 'utf8');
  return b;
};
const parse = (buf) => {
  const out = [];
  const p = tarParser((e) => out.push(e));
  p.push(Buffer.concat([buf, Buffer.alloc(1024)]));
  return out.map(({ path, type, link }) => ({ path, type, link }));
};

test('[PB10] symlink and hardlink targets are kept; different targets give different entries', () => {
  const a = parse(
    Buffer.concat([
      header('lib/libz.so.1', '2', { linkname: 'libz.so.1.3.1' }),
      header('bin/x', '1', { linkname: 'bin/y' }),
    ]),
  );
  assert.deepEqual(a, [
    { path: 'lib/libz.so.1', type: 'symlink', link: 'libz.so.1.3.1' },
    { path: 'bin/x', type: 'hardlink', link: 'bin/y' },
  ]);
  const b = parse(header('lib/libz.so.1', '2', { linkname: 'elsewhere' }));
  assert.notDeepEqual(a[0], b[0]);
});

test('[PB10] long link targets come from pax linkpath and GNU long links', () => {
  const long = `${'d/'.repeat(80)}target`;
  const rec = `linkpath=${long}\n`;
  const pax = `${String(rec.length + String(rec.length).length + 1)} ${rec}`;
  const viaPax = parse(
    Buffer.concat([
      header('PaxHeader', 'x', { size: Buffer.byteLength(pax) }),
      block(pax),
      header('l1', '2', { linkname: 'short' }),
    ]),
  );
  assert.deepEqual(viaPax, [{ path: 'l1', type: 'symlink', link: long }]);
  const viaGnu = parse(
    Buffer.concat([
      header('././@LongLink', 'K', { size: long.length }),
      block(long),
      header('l2', '2', { linkname: 'short' }),
    ]),
  );
  assert.deepEqual(viaGnu, [{ path: 'l2', type: 'symlink', link: long }]);
});

test('[PB10] entry kinds are exact: devices, FIFOs and unknown flags are never reported as files', () => {
  const kinds = parse(
    Buffer.concat(['3', '4', '5', '6', 'Z'].map((f, i) => header(`e${i}`, f))),
  ).map((e) => e.type);
  assert.deepEqual(kinds, ['char', 'block', 'dir', 'fifo', 'other']);
  assert.equal(parse(header('f', '0'))[0].type, 'file');
});
