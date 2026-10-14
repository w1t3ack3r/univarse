// The tar reader keeps link targets and exact entry kinds (spec 0017 PB10: links are part of the inventory).
// Run: node --test tools/images/tar.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedConfig, sameImage } from './gates.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { consumeDockerExport, consumeTar, readFromTar, tarParser } from './tar.mjs';
import { block, header, paxEntry, paxRecord } from './tar-fixtures.mjs';

const parse = (buf) => {
  const out = [];
  const p = tarParser((e) => out.push(e));
  p.push(Buffer.concat([buf, Buffer.alloc(1024)])); // the two end-of-archive blocks
  p.finish();
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

// ---------- premature EOF and malformed input reject through every caller (owner review of e156fa1) ----------

const fileEntry = (name, content) =>
  Buffer.concat([header(name, '0', { size: Buffer.byteLength(content) }), block(content)]);
const END = Buffer.alloc(1024);
const MANIFEST =
  '[{"Config":"blobs/sha256/1111111111111111111111111111111111111111111111111111111111111111"}]';
/** A complete manifest entry, then a pax header declaring 200 bytes but carrying a short payload: genuinely cut off. */
const truncatedAfterManifest = () =>
  Buffer.concat([
    fileEntry('manifest.json', MANIFEST),
    header('PaxHeaders/x', 'x', { size: 200 }),
    Buffer.from('20 path=short\n'),
  ]);
const malformedPax = () =>
  Buffer.concat([fileEntry('manifest.json', MANIFEST), paxEntry(['99 path=x\n'], 'f', '0'), END]);
const finishAfter = (buf) => {
  const p = tarParser(() => {});
  p.push(buf);
  return () => p.finish();
};

test('[PB10] premature EOF is refused: inside data, inside a header, after metadata, or before the end marker', () => {
  assert.throws(
    finishAfter(truncatedAfterManifest()),
    /ended inside an entry's data \(truncated\)/,
  );
  assert.throws(
    finishAfter(header('f', '0').subarray(0, 100)),
    /ended inside a header \(truncated\)/,
  );
  assert.throws(
    finishAfter(paxEntry([paxRecord('path', 'p')], 'f', '0').subarray(0, 1024)),
    /extended metadata, with no entry for it/,
  );
  assert.throws(
    finishAfter(fileEntry('manifest.json', MANIFEST)),
    /no end-of-archive marker \(truncated\)/,
  );
  assert.doesNotThrow(finishAfter(Buffer.concat([fileEntry('manifest.json', MANIFEST), END])));
});

test('[PB10] data after the end-of-archive marker is refused, and a failed parser stays failed', () => {
  const p = tarParser(() => {});
  assert.throws(
    () => p.push(Buffer.concat([END, header('late', '0')])),
    /data after the end-of-archive marker/,
  );
  assert.throws(() => p.push(END), /data after the end-of-archive marker/);
  assert.throws(() => p.finish(), /data after the end-of-archive marker/);
});

/** A temporary tar file holding `bytes`. */
const tmpTar = (bytes) => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-tar-'));
  writeFileSync(join(dir, 'x.tar'), bytes);
  return { dir, path: join(dir, 'x.tar') };
};

test('[PB10] readFromTar rejects premature EOF and malformed input (never resolves, never throws uncaught)', async () => {
  for (const [bytes, re] of [
    [truncatedAfterManifest(), /truncated/],
    [malformedPax(), /pax: the record at byte 0 declares 99 bytes/],
  ]) {
    const { dir, path } = tmpTar(bytes);
    try {
      await assert.rejects(readFromTar(path, 'manifest.json'), re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const { dir, path } = tmpTar(Buffer.concat([fileEntry('manifest.json', MANIFEST), END]));
  try {
    assert.equal((await readFromTar(path, 'manifest.json')).toString(), MANIFEST); // the control
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[PB10] savedConfig and sameImage reject through the caller, and sameImage still removes its temporary tar', async () => {
  for (const [bytes, re] of [
    [truncatedAfterManifest(), /truncated/],
    [malformedPax(), /declares 99 bytes/],
  ]) {
    const work = mkdtempSync(join(tmpdir(), 'uv-gates-'));
    // A stand-in for `docker save image -o <path>` that writes the bad archive.
    const sh = (_cmd, args) => {
      writeFileSync(args[args.indexOf('-o') + 1], bytes);
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await assert.rejects(savedConfig('img', work, 'saved.tar', { sh }), re);
      await assert.rejects(sameImage('img', 'sha256:1', work, { sh }), re);
      assert.deepEqual(
        readdirSync(work).filter((f) => f.startsWith('recheck-')),
        [],
      ); // cleanup ran
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

/** A stand-in for `spawn('docker', ['export', id])`: streams `bytes`, then exits with `code`. */
function fakeSpawn(bytes, code = 0) {
  const calls = { killed: false };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = Readable.from([bytes]);
    child.kill = () => {
      calls.killed = true;
    };
    child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
    child.stdout.on('close', () => setImmediate(() => child.emit('close', code)));
    return child;
  };
  return { spawn, calls };
}

test('[PB10] every docker-export reader rejects premature EOF, malformed input and a failed docker, and stops docker', async () => {
  const ok = Buffer.concat([fileEntry('manifest.json', MANIFEST), END]);
  for (const [bytes, code, re] of [
    [truncatedAfterManifest(), 0, /truncated/],
    [malformedPax(), 0, /declares 99 bytes/],
    [ok, 1, /docker export exited 1/],
  ]) {
    const { spawn, calls } = fakeSpawn(bytes, code);
    await assert.rejects(within(consumeDockerExport('c1', () => {}, {}, { spawn })), re);
    assert.ok(calls.killed, `docker was stopped after: ${re}`);
  }
  const seen = [];
  const { spawn } = fakeSpawn(ok);
  await within(consumeDockerExport('c1', (e) => seen.push(e.path), {}, { spawn })); // the control
  assert.deepEqual(seen, ['manifest.json']);
});

// ---------- lifecycle: either side failing rejects promptly and stops the other (owner review of ede30ce) ----------

/** Fails the test if `promise` is still pending after `ms`: these regressions are about never hanging. */
function within(promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms),
    ),
  ]);
}

/** A controllable stand-in for docker's child process: stdout stays open until the test ends it. */
function controlledChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return { child, spawn: () => child };
}

test('[PB10] consumeTar rejects promptly when the stream closes without ending', async () => {
  const s = new PassThrough();
  const p = consumeTar(s, () => {});
  s.write(header('f', '0', { size: 10 })); // an entry has begun
  s.destroy();
  await assert.rejects(within(p), /closed before it ended \(truncated\)/);
  const empty = new PassThrough();
  const q = consumeTar(empty, () => {});
  empty.destroy();
  await assert.rejects(within(q), /closed before it ended/);
});

test('[PB10] a child startup failure rejects promptly and stops the stream, though stdout never ended', async () => {
  const { child, spawn } = controlledChild();
  const p = consumeDockerExport('c1', () => {}, {}, { spawn });
  child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(within(p), /ENOENT/);
  assert.ok(child.stdout.destroyed, 'stdout was stopped');
  assert.ok(child.killed, 'the child was stopped');
});

test('[PB10] a non-zero child exit rejects promptly and stops the stream, while stdout is still open', async () => {
  const { child, spawn } = controlledChild();
  const p = consumeDockerExport('c1', () => {}, {}, { spawn });
  child.stdout.write(header('f', '0', { size: 10 })); // mid-archive, not ended
  child.emit('close', 1);
  await assert.rejects(within(p), /docker export exited 1/);
  assert.ok(child.stdout.destroyed, 'stdout was stopped');
});

test('[PB10] success needs both a complete archive and a zero exit, in either order', async () => {
  const archive = Buffer.concat([fileEntry('manifest.json', MANIFEST), END]);
  // Archive first: still pending until docker exits 0.
  let { child, spawn } = controlledChild();
  let settled = false;
  let p = consumeDockerExport('c1', () => {}, {}, { spawn }).then(() => (settled = true));
  child.stdout.end(archive);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, 'resolved before docker exited');
  child.emit('close', 0);
  await within(p);
  // Exit first: still pending until the archive is complete.
  ({ child, spawn } = controlledChild());
  settled = false;
  p = consumeDockerExport('c1', () => {}, {}, { spawn }).then(() => (settled = true));
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, 'resolved before the archive was complete');
  child.stdout.end(archive);
  await within(p);
});
