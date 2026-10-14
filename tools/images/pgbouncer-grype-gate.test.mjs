// Spec 0017 PB10: unit tests for the Grype gate's analysis (database status, digest, routing, disagreements,
// parity). The run-level controls (real database, real images) are in pgbouncer-gate-proofs.mjs.
// Run: node --test tools/images/pgbouncer-grype-gate.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDbStatus,
  debIdentity,
  disagreements,
  importDigest,
  parity,
  provenance,
  routeFindings,
} from './pgbouncer-grype-gate.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const status = (over = {}) => ({
  schemaVersion: 'v6.1.10',
  from: 'https://grype.anchore.io/databases/v6/x.tar.zst',
  built: '2026-10-13T06:35:20Z',
  path: '/cache/6/vulnerability.db',
  valid: true,
  ...over,
});
const has = (problems, re) =>
  assert.ok(
    problems.some((p) => re.test(p)),
    `expected ${re} in:\n${problems.join('\n')}`,
  );

test('[PB10] database status: a valid, fresh database passes; invalid, stale, future, or malformed fields fail', () => {
  assert.deepEqual(checkDbStatus(status(), NOW), []);
  has(
    checkDbStatus(status({ valid: false, error: 'hash mismatch' }), NOW),
    /not valid .*hash mismatch/,
  );
  has(checkDbStatus(status({ built: '2026-10-11T06:00:00Z' }), NOW), /more than 48 h ago/);
  has(checkDbStatus(status({ built: '2026-10-20T00:00:00Z' }), NOW), /in the future/);
  has(checkDbStatus(status({ built: undefined }), NOW), /built time is missing/);
  has(checkDbStatus(status({ schemaVersion: '' }), NOW), /schemaVersion is missing/);
  has(checkDbStatus(status({ path: undefined }), NOW), /path is missing/);
  has(checkDbStatus(null, NOW), /no JSON object/);
});

test('[PB10] the database digest comes from import.json as xxh64, or the gate fails', () => {
  assert.deepEqual(importDigest({ digest: 'xxh64:0ebdf559edec4ee5' }), {
    digest: 'xxh64:0ebdf559edec4ee5',
  });
  assert.match(importDigest({ digest: 'sha256:abc' }).problem, /no valid xxh64 digest/);
  assert.match(importDigest({}).problem, /no valid xxh64 digest/);
});

const deb = (name, version, extra = '') => ({
  name,
  version,
  purl: `pkg:deb/debian/${name}@${encodeURIComponent(version)}?arch=amd64&distro=debian-13.7${extra}`,
});
const pgb = (version) => ({ name: 'pgbouncer', version, purl: `pkg:generic/pgbouncer@${version}` });
const match = (artifact, id, severity) => ({ artifact, vulnerability: { id, severity } });

test('[PB10] routing is by provenance: PgBouncer HIGH/CRITICAL blocks, Debian findings go to Trivy, unknown is refused', () => {
  const r = routeFindings({
    matches: [
      match(pgb('1.25.0'), 'CVE-2026-19888', 'High'),
      match(pgb('1.25.0'), 'CVE-2026-6669', 'Medium'),
      match(deb('libc6', '2.41-12+deb13u4', '&upstream=glibc'), 'CVE-2026-5435', 'High'),
      match({ name: 'mystery', version: '1', purl: 'pkg:npm/mystery@1' }, 'CVE-1', 'Low'),
    ],
  });
  assert.deepEqual(
    r.blocking.map((f) => f.id),
    ['CVE-2026-19888'],
  ); // a Debian HIGH never blocks here; a PgBouncer MEDIUM doesn't
  assert.deepEqual(
    r.routedToTrivy.map((f) => f.id),
    ['CVE-2026-5435'],
  );
  has(r.problems, /mystery@1 .* has no routing: refused/);
  assert.equal(
    provenance({ name: 'pgbouncer', purl: 'pkg:generic/pgbouncer@1.26.0' }),
    'pgbouncer',
  );
  assert.equal(provenance({ name: 'other', purl: 'pkg:generic/pgbouncer@1.26.0' }), null);
});

test('[PB10] disagreements are recorded per package and CVE, for disclosure only', () => {
  const grype = {
    matches: [
      match(deb('libc6', '2.41'), 'CVE-2026-5435', 'High'),
      match(deb('zlib1g', '1.3'), 'CVE-2026-85091', 'High'),
      match(deb('libc6', '2.41'), 'CVE-X', 'Medium'),
    ],
  };
  const trivy = {
    Results: [
      {
        Vulnerabilities: [
          { PkgName: 'libc6', VulnerabilityID: 'CVE-2026-5435', Severity: 'MEDIUM' },
          { PkgName: 'zlib1g', VulnerabilityID: 'CVE-2026-85091', Severity: 'MEDIUM' },
          { PkgName: 'libc6', VulnerabilityID: 'CVE-X', Severity: 'MEDIUM' },
        ],
      },
    ],
  };
  assert.deepEqual(disagreements(grype, trivy), [
    { package: 'libc6', id: 'CVE-2026-5435', grype: 'HIGH', trivy: 'MEDIUM' },
    { package: 'zlib1g', id: 'CVE-2026-85091', grype: 'HIGH', trivy: 'MEDIUM' },
  ]);
});

test('[PB10] Debian identity is name, version, arch and source package', () => {
  assert.deepEqual(
    debIdentity(
      'pkg:deb/debian/zlib1g@1%3A1.3-1%2Bb1?arch=amd64&distro=debian-13.7&upstream=zlib%401%3A1.3-1',
    ),
    {
      name: 'zlib1g',
      version: '1:1.3-1+b1',
      arch: 'amd64',
      source: 'zlib',
    },
  );
  assert.equal(
    debIdentity('pkg:deb/debian/base-files@13.8?arch=amd64&distro=debian-13.7').source,
    'base-files',
  );
  assert.equal(debIdentity('pkg:generic/pgbouncer@1.26.0'), null);
});

/** A consistent world: inventory, its scan and catalogue, and the image's scan and catalogue. */
function world() {
  const libc = deb('libc6', '2.41-12+deb13u4', '&upstream=glibc');
  const zlib = deb('zlib1g', '1:1.3-1+b1', '&upstream=zlib');
  const cpe = 'cpe:2.3:a:pgbouncer:pgbouncer:1.26.0:*:*:*:*:*:*:*';
  return {
    inventory: { components: [{ ...pgb('1.26.0'), cpe }, libc, zlib] },
    inventoryScan: { matches: [match(libc, 'CVE-2026-5435', 'High')] },
    inventoryCatalogue: { components: [{ name: 'pgbouncer', version: '1.26.0', cpe }, libc, zlib] },
    imageScan: { matches: [match(libc, 'CVE-2026-5435', 'High')] },
    imageCatalogue: { components: [libc, zlib] },
  };
}

test('[PB10] parity: a consistent inventory passes', () => {
  assert.deepEqual(parity(world()), []);
});

test('[PB10] parity: an omitted Debian package with no CVEs fails (identities are compared, not only findings)', () => {
  const w = world();
  w.inventory.components = w.inventory.components.filter((c) => c.name !== 'zlib1g'); // zlib has no findings here
  has(
    parity(w),
    /Debian package zlib1g\|1:1\.3-1\+b1\|amd64\|zlib is in the image but not in the inventory/,
  );
});

test('[PB10] parity: a wrong version or source, or a finding on only one side, fails', () => {
  let w = world();
  w.inventory.components[1] = deb('libc6', '2.40-1', '&upstream=glibc');
  has(parity(w), /libc6\|2\.41-12\+deb13u4\|amd64\|glibc is in the image but not in the inventory/);
  w = world();
  w.inventory.components[1] = deb('libc6', '2.41-12+deb13u4'); // upstream (source) dropped: Grype would match nothing
  has(parity(w), /libc6\|2\.41-12\+deb13u4\|amd64\|libc6 is in the inventory but not in the image/);
  w = world();
  w.inventoryScan.matches = [];
  has(
    parity(w),
    /Grype finds libc6\|2\.41-12\+deb13u4\|CVE-2026-5435 on the image but not on the inventory/,
  );
});

test('[PB10] parity: PgBouncer coverage is checked separately: missing, wrong CPE, not ingested, or seen in the image', () => {
  let w = world();
  w.inventory.components = w.inventory.components.filter((c) => c.name !== 'pgbouncer');
  has(parity(w), /0 PgBouncer components, expected 1/);
  w = world();
  w.inventory.components[0].cpe = 'cpe:2.3:a:other:pgbouncer:1.26.0:*:*:*:*:*:*:*';
  has(parity(w), /PgBouncer CPE is cpe:2\.3:a:other/);
  w = world();
  w.inventoryCatalogue.components = w.inventoryCatalogue.components.filter(
    (c) => c.name !== 'pgbouncer',
  );
  has(parity(w), /did not ingest the PgBouncer component/);
  w = world();
  w.imageCatalogue.components.push({ name: 'pgbouncer', version: '1.26.0' });
  has(parity(w), /catalogue of the image found a PgBouncer package/);
  w = world();
  w.imageCatalogue.components = [];
  has(parity(w), /no Debian packages: parity can't be shown/);
});
