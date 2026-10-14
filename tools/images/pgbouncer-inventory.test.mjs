// Spec 0017 PB10: unit tests for the inventory and tie checks, on synthetic facts. Each "fails" case must be refused
// for its intended reason; the clean case is the control. Run: node --test tools/images/pgbouncer-inventory.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildInventory,
  checkFacts,
  checkInventory,
  debianUpstream,
  debPurl,
  LIBEVENT_PKG,
  parseControl,
  parseVersionOutput,
  pgbouncerCpe,
} from './pgbouncer-inventory.mjs';
import { tarParser } from './tar.mjs';
import { paxEntry, paxRecord, parseArchive } from './tar-fixtures.mjs';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const file = (content) => ({ sha256: sha(content), md5: md5(content) });
/** A copy of `obj` without `key`. */
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
const S = 'var/lib/dpkg/status.d/';

/** A tiny base (zlib1g, plus ca-certificates listing a file distroless doesn't ship) and the final image on top. */
function fixture() {
  const zlibCtl =
    'Package: zlib1g\nSource: zlib (1:1.3.dfsg+really1.3.1-1)\nVersion: 1:1.3.dfsg+really1.3.1-1+b1\nArchitecture: amd64\n';
  const zlibSums = `${md5('ZLIB')}  usr/lib/x86_64-linux-gnu/libz.so.1.3.1\n`;
  const caCtl = 'Package: ca-certificates\nVersion: 20250419\nArchitecture: all\n';
  const caSums = `${md5('BUNDLE')}  etc/ssl/certs/ca-certificates.crt\n${md5('NOT SHIPPED')}  usr/sbin/update-ca-certificates\n`;
  const baseFiles = {
    'etc/debian_version': { ...file('13.7'), text: '13.7' },
    'usr/lib/x86_64-linux-gnu/libz.so.1.3.1': file('ZLIB'),
    'etc/ssl/certs/ca-certificates.crt': file('BUNDLE'),
    [`${S}zlib1g`]: file(zlibCtl),
    [`${S}zlib1g.md5sums`]: file(zlibSums),
    [`${S}ca-certificates`]: file(caCtl),
    [`${S}ca-certificates.md5sums`]: file(caSums),
  };
  const baseRecords = {
    zlib1g: { control: zlibCtl, md5sums: zlibSums },
    'ca-certificates': { control: caCtl, md5sums: caSums },
  };
  const evCtl = `Package: ${LIBEVENT_PKG}\nSource: libevent\nVersion: 2.1.13-stable-1~deb13u1\nArchitecture: amd64\n`;
  const evSums = `${md5('EVENT')}  usr/lib/x86_64-linux-gnu/libevent-2.1.so.7.0.2\n${md5('COPYRIGHT')}  usr/share/doc/${LIBEVENT_PKG}/copyright\n`;
  const files = {
    ...structuredClone(baseFiles),
    'usr/bin/pgbouncer': file('PGBOUNCER-1.26.0'),
    'usr/lib/x86_64-linux-gnu/libevent-2.1.so.7.0.2': file('EVENT'),
    [`usr/share/doc/${LIBEVENT_PKG}/copyright`]: file('COPYRIGHT'),
    [`${S}${LIBEVENT_PKG}`]: file(evCtl),
    [`${S}${LIBEVENT_PKG}.md5sums`]: file(evSums),
  };
  // Directories and a base symlink, as a real image has them; the build adds libevent's soname link and its doc dir.
  const baseEntries = [
    { path: 'etc/', type: 'dir' },
    { path: 'usr/lib/x86_64-linux-gnu/', type: 'dir' },
    { path: 'usr/lib/x86_64-linux-gnu/libz.so.1', type: 'symlink', link: 'libz.so.1.3.1' },
    ...Object.keys(baseFiles).map((path) => ({ path, type: 'file' })),
  ];
  const addedEntries = [
    { path: 'usr/bin/', type: 'dir' },
    { path: `usr/share/doc/${LIBEVENT_PKG}/`, type: 'dir' },
    {
      path: 'usr/lib/x86_64-linux-gnu/libevent-2.1.so.7',
      type: 'symlink',
      link: 'libevent-2.1.so.7.0.2',
    },
    ...Object.keys(files)
      .filter((p) => !baseFiles[p])
      .map((path) => ({ path, type: 'file' })),
  ];
  const facts = {
    imageId: 'sha256:abc',
    labels: {
      'org.univarse.pgbouncer.version': '1.26.0',
      'org.univarse.pgbouncer.source-sha256': 'deadbeef',
    },
    versionOutput: 'PgBouncer 1.26.0\nlibevent 2.1.13-stable\nadns: evdns2\n',
    records: {
      ...structuredClone(baseRecords),
      [LIBEVENT_PKG]: { control: evCtl, md5sums: evSums },
    },
    files,
    entries: [...structuredClone(baseEntries), ...addedEntries],
  };
  const base = { records: baseRecords, files: baseFiles, entries: baseEntries };
  const pins = { runtimeImage: 'base@sha256:1', version: '1.26.0', sourceSha256: 'deadbeef' };
  return { facts, base, pins };
}
const fails = (problems, re) =>
  assert.ok(
    problems.some((p) => re.test(p)),
    `expected a problem matching ${re}, got:\n${problems.join('\n')}`,
  );

test('[PB10] the clean control passes, and its inventory verifies', () => {
  const { facts, base, pins } = fixture();
  assert.deepEqual(checkFacts(facts, base, pins), []);
  const inv = buildInventory(facts, pins);
  assert.deepEqual(checkInventory(structuredClone(inv), facts, pins), []);
  // The base's own deviation (a listed file distroless doesn't ship) is written explicitly, not filtered out.
  const ca = inv.components.find((c) => c.name === 'ca-certificates');
  assert.ok(
    ca.properties.some((p) => p.name === 'univarse:file-absent:usr/sbin/update-ca-certificates'),
  );
});

test('[PB10] a base library removed, its package record unchanged, fails', () => {
  const { facts, base, pins } = fixture();
  delete facts.files['usr/lib/x86_64-linux-gnu/libz.so.1.3.1'];
  facts.entries = facts.entries.filter((e) => e.path !== 'usr/lib/x86_64-linux-gnu/libz.so.1.3.1');
  fails(checkFacts(facts, base, pins), /libz\.so\.1\.3\.1, a file of the base image, is missing/);
});

test('[PB10] a base library altered, its package record unchanged, fails', () => {
  const { facts, base, pins } = fixture();
  facts.files['usr/lib/x86_64-linux-gnu/libz.so.1.3.1'] = file('ZLIB-TAMPERED');
  const problems = checkFacts(facts, base, pins);
  fails(problems, /libz\.so\.1\.3\.1 differs from the base image's copy/);
  fails(
    problems,
    /zlib1g:usr\/lib\/x86_64-linux-gnu\/libz\.so\.1\.3\.1: differs from its listed md5, which the base image doesn't do/,
  );
});

test('[PB10] a base file whose hash information is missing fails (it is never silently accepted)', () => {
  const { facts, base, pins } = fixture();
  delete facts.files['etc/ssl/certs/ca-certificates.crt'];
  fails(
    checkFacts(facts, base, pins),
    /ca-certificates\.crt, a file of the base image, is missing/,
  );
});

test('[PB10] an unrecorded addition (an extra shared library) fails', () => {
  const { facts, base, pins } = fixture();
  facts.files['usr/lib/x86_64-linux-gnu/libcares.so.2'] = file('CARES');
  facts.entries.push({ path: 'usr/lib/x86_64-linux-gnu/libcares.so.2', type: 'file' });
  fails(
    checkFacts(facts, base, pins),
    /libcares\.so\.2 is in the image but is neither a base file nor an expected addition/,
  );
});

test('[PB10] libevent: altered bytes, a version disagreeing with the binary, or a missing record each fail', () => {
  let { facts, base, pins } = fixture();
  facts.files['usr/lib/x86_64-linux-gnu/libevent-2.1.so.7.0.2'] = file('EVENT-TAMPERED');
  fails(
    checkFacts(facts, base, pins),
    /libevent-2\.1\.so\.7\.0\.2: differs from its listed md5, against its libevent-2\.1-7t64 record/,
  );
  ({ facts, base, pins } = fixture());
  facts.versionOutput = 'PgBouncer 1.26.0\nlibevent 2.1.12-stable\nadns: evdns2\n';
  fails(
    checkFacts(facts, base, pins),
    /reports libevent 2\.1\.12-stable, but the libevent-2\.1-7t64 record's version is/,
  );
  ({ facts, base, pins } = fixture());
  facts.records = without(facts.records, LIBEVENT_PKG);
  fails(checkFacts(facts, base, pins), /no package record for libevent-2\.1-7t64/);
});

test('[PB10] lying metadata: a binary reporting 1.25.0 under 1.26.0 labels fails the tie check', () => {
  const { facts, base, pins } = fixture();
  facts.versionOutput = 'PgBouncer 1.25.0\nlibevent 2.1.13-stable\nadns: evdns2\n';
  fails(
    checkFacts(facts, base, pins),
    /the binary reports PgBouncer 1\.25\.0, but the image declares 1\.26\.0/,
  );
});

test('[PB10] c-ares instead of evdns, or an unpinned source hash, fails', () => {
  let { facts, base, pins } = fixture();
  facts.versionOutput = 'PgBouncer 1.26.0\nlibevent 2.1.13-stable\nadns: c-ares 1.34.5\n';
  fails(checkFacts(facts, base, pins), /DNS is "c-ares", expected libevent's evdns2/);
  ({ facts, base, pins } = fixture());
  facts.labels['org.univarse.pgbouncer.source-sha256'] = 'cafe';
  fails(
    checkFacts(facts, base, pins),
    /declares source SHA-256 cafe, but the Dockerfile pins deadbeef/,
  );
});

test('[PB10] an edited inventory fails: missing PgBouncer, a wrong CPE, a missing version, another image', () => {
  const { facts, pins } = fixture();
  const inv = () => buildInventory(facts, pins);
  let i = inv();
  i.components = i.components.filter((c) => c.name !== 'pgbouncer');
  fails(checkInventory(i, facts, pins), /0 PgBouncer components, expected exactly 1/);
  i = inv();
  i.components[0].cpe = 'cpe:2.3:a:otherco:pgbouncer:1.26.0:*:*:*:*:*:*:*';
  fails(checkInventory(i, facts, pins), /PgBouncer CPE is cpe:2\.3:a:otherco/);
  i = inv();
  delete i.components[0].version;
  fails(checkInventory(i, facts, pins), /PgBouncer component has no version/);
  i = inv();
  i.metadata.component.version = 'sha256:other';
  fails(checkInventory(i, facts, pins), /inventory is for image sha256:other/);
  i = inv();
  i.components = i.components.filter((c) => c.name !== 'zlib1g');
  fails(checkInventory(i, facts, pins), /differs from what the image's own facts produce/);
});

test('[PB10] the inventory refuses to be built with a missing hash rather than leave it out', () => {
  const { facts, pins } = fixture();
  delete facts.files['usr/bin/pgbouncer'];
  assert.throws(() => buildInventory(facts, pins), /usr\/bin\/pgbouncer's hash is missing/);
  const f2 = fixture();
  delete f2.facts.files['etc/debian_version'];
  assert.throws(() => buildInventory(f2.facts, f2.pins), /etc\/debian_version is missing/);
});

test('[PB10] parsing: Debian purls carry the source package; versions; control fields', () => {
  const c = parseControl(
    'Package: libc6\nSource: glibc\nVersion: 2.41-12+deb13u4\nArchitecture: amd64\n',
  );
  assert.equal(
    debPurl(c, '13.7'),
    'pkg:deb/debian/libc6@2.41-12%2Bdeb13u4?arch=amd64&distro=debian-13.7&upstream=glibc',
  );
  const z = parseControl(
    'Package: zlib1g\nSource: zlib (1:1.3.dfsg+really1.3.1-1)\nVersion: 1:1.3.dfsg+really1.3.1-1+b1\nArchitecture: amd64\n',
  );
  assert.match(debPurl(z, '13.7'), /&upstream=zlib%401%3A1\.3\.dfsg%2Breally1\.3\.1-1$/);
  assert.equal(debianUpstream('2.1.13-stable-1~deb13u1'), '2.1.13-stable');
  assert.equal(debianUpstream('1:1.3.dfsg+really1.3.1-1+b1'), '1.3.dfsg+really1.3.1');
  assert.deepEqual(parseVersionOutput('PgBouncer 1.26.0\nlibevent 2.1.13-stable\nadns: evdns2\n'), {
    pgbouncer: '1.26.0',
    libevent: '2.1.13-stable',
    adns: 'evdns2',
  });
  assert.equal(pgbouncerCpe('1.26.0'), 'cpe:2.3:a:pgbouncer:pgbouncer:1.26.0:*:*:*:*:*:*:*');
});

// ---------- links, entry kinds and complete hashes (owner review of 38ef2fa) ----------

const linkOf = (facts, path) => facts.entries.find((e) => e.path === path);

test('[PB10] a retargeted or removed base link fails', () => {
  let { facts, base, pins } = fixture();
  linkOf(facts, 'usr/lib/x86_64-linux-gnu/libz.so.1').link = 'libz.so.9';
  fails(
    checkFacts(facts, base, pins),
    /libz\.so\.1 links to libz\.so\.9, but the base image's link points to libz\.so\.1\.3\.1/,
  );
  ({ facts, base, pins } = fixture());
  facts.entries = facts.entries.filter((e) => e.path !== 'usr/lib/x86_64-linux-gnu/libz.so.1');
  fails(checkFacts(facts, base, pins), /libz\.so\.1, a symlink of the base image, is missing/);
});

test('[PB10] two links with different targets are different facts (targets are read, not discarded)', () => {
  const a = fixture();
  const b = fixture();
  linkOf(b.facts, 'usr/lib/x86_64-linux-gnu/libz.so.1').link = 'elsewhere';
  assert.notDeepEqual(a.facts.entries, b.facts.entries);
  assert.notDeepEqual(buildInventory(a.facts, a.pins), buildInventory(b.facts, b.pins));
});

test("[PB10] an extra unowned link fails, and so does libevent's soname link pointing outside libevent", () => {
  let { facts, base, pins } = fixture();
  facts.entries.push({
    path: 'usr/lib/x86_64-linux-gnu/libcares.so.2',
    type: 'symlink',
    link: 'libz.so.1.3.1',
  });
  fails(
    checkFacts(facts, base, pins),
    /libcares\.so\.2 is a link in the image that is neither the base's nor an expected addition/,
  );
  ({ facts, base, pins } = fixture());
  linkOf(facts, 'usr/lib/x86_64-linux-gnu/libevent-2.1.so.7').link = 'libz.so.1.3.1';
  fails(
    checkFacts(facts, base, pins),
    /libevent-2\.1\.so\.7 links to libz\.so\.1\.3\.1, which isn't one of libevent-2\.1-7t64's files/,
  );
});

test('[PB10] hardlinks, devices and unknown entry kinds are rejected; a base file swapped for a link fails', () => {
  let { facts, base, pins } = fixture();
  facts.entries.push({ path: 'usr/bin/pgbouncer2', type: 'hardlink', link: 'usr/bin/pgbouncer' });
  fails(
    checkFacts(facts, base, pins),
    /pgbouncer2 is a hardlink entry: only regular files, directories and symlinks are supported/,
  );
  ({ facts, base, pins } = fixture());
  facts.entries.push({ path: 'dev/sda', type: 'block' }, { path: 'x', type: 'other' });
  const p = checkFacts(facts, base, pins);
  fails(p, /dev\/sda is a block entry/);
  fails(p, /x is a other entry/);
  ({ facts, base, pins } = fixture());
  const e = facts.entries.find((x) => x.path === 'etc/ssl/certs/ca-certificates.crt');
  e.type = 'symlink';
  e.link = '/tmp/evil.crt';
  fails(
    checkFacts(facts, base, pins),
    /ca-certificates\.crt is a symlink, but the base image has a file/,
  );
});

test('[PB10] a present file without a valid SHA-256 fails, even with its md5 intact (libevent)', () => {
  const { facts, base, pins } = fixture();
  delete facts.files['usr/lib/x86_64-linux-gnu/libevent-2.1.so.7.0.2'].sha256;
  fails(checkFacts(facts, base, pins), /libevent-2\.1\.so\.7\.0\.2 has no valid SHA-256 and md5/);
  assert.throws(
    () => buildInventory(facts, pins),
    /libevent-2\.1\.so\.7\.0\.2's hash is missing or invalid/,
  );
});

test('[PB10] every regular file is in the inventory, including base files no record lists', () => {
  const { facts, base, pins } = fixture();
  // etc/debian_version and the CA bundle's record files are listed by no md5sums: they must still be inventoried.
  const inv = buildInventory(facts, pins);
  const names = new Set(inv.components.flatMap((c) => (c.properties ?? []).map((p) => p.name)));
  for (const e of facts.entries.filter((x) => x.type === 'file' && x.path !== 'usr/bin/pgbouncer'))
    assert.ok(
      names.has(`univarse:file-sha256:${e.path}`),
      `${e.path} is missing from the inventory`,
    );
  assert.ok(names.has('univarse:symlink:usr/lib/x86_64-linux-gnu/libz.so.1'));
  assert.deepEqual(checkFacts(facts, base, pins), []);
  // An inventory with one of those files removed no longer verifies.
  const files = inv.components.find((c) => c['bom-ref'] === 'image-files');
  files.properties = files.properties.filter(
    (p) => p.name !== 'univarse:file-sha256:etc/debian_version',
  );
  fails(checkInventory(inv, facts, pins), /differs from what the image's own facts produce/);
});

test('[PB10] an approved absence and a present file differing from its record are marked distinctly', () => {
  const { facts, base, pins } = fixture();
  // The base ships zlib's library with bytes its own record doesn't list (as distroless does with os-release).
  for (const f of [base.files, facts.files])
    f['usr/lib/x86_64-linux-gnu/libz.so.1.3.1'] = file('ZLIB-AS-THE-BASE-SHIPS-IT');
  assert.deepEqual(checkFacts(facts, base, pins), []);
  const zlib = buildInventory(facts, pins).components.find((c) => c.name === 'zlib1g');
  const names = zlib.properties.map((p) => p.name);
  assert.ok(names.includes('univarse:file-sha256:usr/lib/x86_64-linux-gnu/libz.so.1.3.1'));
  assert.ok(
    names.includes('univarse:file-md5-differs-from-record:usr/lib/x86_64-linux-gnu/libz.so.1.3.1'),
  );
  assert.ok(!names.some((n) => n.startsWith('univarse:file-absent:')));
  const ca = buildInventory(facts, pins).components.find((c) => c.name === 'ca-certificates');
  assert.ok(
    ca.properties.some((p) => p.name === 'univarse:file-absent:usr/sbin/update-ca-certificates'),
  );
  assert.ok(
    !ca.properties.some((p) => p.name.startsWith('univarse:file-md5-differs-from-record:')),
  );
});

test('[PB10] a file entry with no hash record at all fails (not only a record missing its SHA-256)', () => {
  const { facts, base, pins } = fixture();
  facts.files = without(facts.files, `usr/share/doc/${LIBEVENT_PKG}/copyright`);
  fails(checkFacts(facts, base, pins), /copyright has no valid SHA-256 and md5/);
});

// ---------- archive-level: entries come from the real tar reader (owner review of ff86783) ----------

test('[PB10] archive: a base link retargeted with a newline-padded pax linkpath is caught', () => {
  const { facts, base, pins } = fixture();
  const path = 'usr/lib/x86_64-linux-gnu/libz.so.1';
  const target = `libz.so.1.3.1\n${'y'.repeat(140)}`;
  const [e] = parseArchive(
    paxEntry([paxRecord('linkpath', target)], path, '2', 'libz.so.1.3.1'),
    tarParser,
  );
  assert.equal(e.link, target); // the reader doesn't cut the target at its newline
  facts.entries = facts.entries.map((x) => (x.path === path ? e : x));
  fails(checkFacts(facts, base, pins), /libz\.so\.1 links to libz\.so\.1\.3\.1\n/);
});

test('[PB10] archive: an unowned link whose target hides a fake `path=` record is caught as itself', () => {
  const { facts, base, pins } = fixture();
  const fake = `x\n${paxRecord('path', 'usr/lib/x86_64-linux-gnu/libz.so.1')}`;
  const [e] = parseArchive(
    paxEntry([paxRecord('linkpath', fake)], 'etc/unowned-link', '2'),
    tarParser,
  );
  assert.equal(e.path, 'etc/unowned-link'); // the embedded text isn't read as metadata
  facts.entries.push(e);
  fails(
    checkFacts(facts, base, pins),
    /etc\/unowned-link is a link in the image that is neither the base's nor an expected addition/,
  );
});
