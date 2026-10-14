// The tar reader keeps link targets and exact entry kinds (spec 0017 PB10: links are part of the inventory).
// Run: node --test tools/images/tar.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tarParser } from './tar.mjs';
import { block, header, paxEntry, paxRecord } from './tar-fixtures.mjs';

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

// ---------- pax records are decoded by declared byte length (owner review of ff86783) ----------

test('[PB10] a link target containing a newline is kept whole, not cut at the newline', () => {
  const target = `libz.so.1.3.1\n${'y'.repeat(140)}`;
  const [e] = parse(
    paxEntry(
      [paxRecord('linkpath', target)],
      'usr/lib/x86_64-linux-gnu/libz.so.1',
      '2',
      'libz.so.1.3.1',
    ),
  );
  assert.equal(e.path, 'usr/lib/x86_64-linux-gnu/libz.so.1');
  assert.equal(e.link, target);
});

test('[PB10] text inside a value that looks like a record is never read as metadata', () => {
  const fake = `x\n${paxRecord('path', 'usr/lib/x86_64-linux-gnu/libz.so.1')}`;
  const [e] = parse(paxEntry([paxRecord('linkpath', fake)], 'etc/unowned-link', '2'));
  assert.equal(e.path, 'etc/unowned-link');
  assert.equal(e.link, fake);
});

test('[PB10] record lengths count UTF-8 bytes, not characters', () => {
  const target = 'lïb/日本語/libz.so';
  const [e] = parse(paxEntry([paxRecord('linkpath', target)], 'l', '2'));
  assert.equal(e.link, target);
  // A length counted in characters (as a naive writer might) is short of the record's bytes: refused.
  const chars = ` linkpath=${target}\n`.length;
  const wrong = `${chars + String(chars).length} linkpath=${target}\n`;
  assert.throws(() => parse(paxEntry([wrong], 'l', '2')), /pax: /);
});

test('[PB10] malformed or unsupported pax input is refused, never half-read', () => {
  const bad = (records, re) => assert.throws(() => parse(paxEntry(records, 'f', '0')), re);
  bad(['99 path=short\n'], /declares 99 bytes, which overruns the header/); // truncated: declared beyond the data
  bad(['14 path=abcdef '], /doesn't end in a newline/);
  bad(['014 path=abcde\n'], /zero-padded record length/);
  bad(['11 pathabc\n'], /has no key/); // a well-framed 11-byte record with no '='
  bad(['x path=a\n'], /malformed record length/);
  bad([paxRecord('path', 'a'), paxRecord('path', 'b')], /key path is repeated/);
  bad([paxRecord('size', '5')], /a size override is not supported/);
  bad([paxRecord('uid', '-1')], /isn't a decimal number/);
  const invalid = Buffer.concat([
    Buffer.from('13 path=a'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\n'),
  ]);
  const padded = Buffer.alloc(512);
  invalid.copy(padded);
  assert.throws(
    () =>
      parse(Buffer.concat([header('P', 'x', { size: invalid.length }), padded, header('f', '0')])),
    /./,
  );
  const g = Buffer.alloc(512);
  Buffer.from(paxRecord('path', 'everything')).copy(g);
  assert.throws(
    () =>
      parse(
        Buffer.concat([
          header('G', 'g', { size: paxRecord('path', 'everything').length }),
          g,
          header('f', '0'),
        ]),
      ),
    /global header setting path/,
  );
});

test('[PB10] pax uid and gid override the header; a zero-length extended header applies to nothing', () => {
  const out = [];
  const p = tarParser((e) => out.push(e));
  p.push(
    Buffer.concat([
      paxEntry([paxRecord('uid', '70000'), paxRecord('gid', '70001')], 'f', '0'),
      header('Z', 'x'),
      header('g2', '0'),
      Buffer.alloc(1024),
    ]),
  );
  assert.deepEqual(
    out.map(({ path, uid, gid }) => ({ path, uid, gid })),
    [
      { path: 'f', uid: 70000, gid: 70001 },
      { path: 'g2', uid: 0, gid: 0 },
    ],
  );
});
