// Spec 0017 PB10: unit tests for the Grype gate: its analysis (database status, digest, routing, disagreements,
// parity, binding) and its runner, with Docker, the inventory verifier and the archive reader mocked. The run-level
// controls on real images and a real database are in pgbouncer-gate-proofs.mjs.
// Run: node --test tools/images/pgbouncer-grype-gate.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bindingProblems,
  checkDbStatus,
  debIdentity,
  disagreements,
  GRYPE_IMAGE,
  importDigest,
  parity,
  provenance,
  READER_IMAGE,
  routeFindings,
  runGate,
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

const deb = (name, version, upstream = '') => ({
  name,
  version,
  purl: `pkg:deb/debian/${name}@${encodeURIComponent(version)}?arch=amd64&distro=debian-13.7${upstream ? `&upstream=${encodeURIComponent(upstream)}` : ''}`,
});
const pgb = (version) => ({ name: 'pgbouncer', version, purl: `pkg:generic/pgbouncer@${version}` });
const match = (artifact, id, severity) => ({ artifact, vulnerability: { id, severity } });
const CPE = 'cpe:2.3:a:pgbouncer:pgbouncer:1.26.0:*:*:*:*:*:*:*';

test('[PB10] routing is by provenance: PgBouncer HIGH/CRITICAL blocks, Debian findings go to Trivy, unknown is refused', () => {
  const r = routeFindings({
    matches: [
      match(pgb('1.25.0'), 'CVE-2026-19888', 'High'),
      match(pgb('1.25.0'), 'CVE-2026-6669', 'Medium'),
      match(deb('libc6', '2.41-12+deb13u4', 'glibc'), 'CVE-2026-5435', 'High'),
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

test('[PB10] Debian identity keeps the source version and distro (nothing normalised away)', () => {
  assert.deepEqual(
    debIdentity(
      'pkg:deb/debian/zlib1g@1%3A1.3-1%2Bb1?arch=amd64&distro=debian-13.7&upstream=zlib%401%3A1.3-1',
    ),
    {
      name: 'zlib1g',
      version: '1:1.3-1+b1',
      arch: 'amd64',
      source: 'zlib',
      sourceVersion: '1:1.3-1',
      distro: 'debian-13.7',
    },
  );
  const b = debIdentity('pkg:deb/debian/base-files@13.8?arch=amd64&distro=debian-13.7');
  assert.equal(b.source, 'base-files');
  assert.equal(b.sourceVersion, null);
  assert.equal(debIdentity('pkg:generic/pgbouncer@1.26.0'), null);
});

/** A consistent world: inventory, the catalogue Grype ingested from it, its scan, and the image's scan and catalogue. */
function world() {
  const libc = deb('libc6', '2.41-12+deb13u4', 'glibc');
  const zlib = deb('zlib1g', '1:1.3-1+b1', 'zlib@1:1.3-1'); // has no findings below: "CVE-free"
  return {
    inventory: { components: [{ ...pgb('1.26.0'), cpe: CPE }, libc, zlib] },
    inventoryScan: { matches: [match(libc, 'CVE-2026-5435', 'High')] },
    inventoryCatalogue: { components: [{ ...pgb('1.26.0'), cpe: CPE }, { ...libc }, { ...zlib }] },
    imageScan: { matches: [match(libc, 'CVE-2026-5435', 'High')] },
    imageCatalogue: { components: [{ ...libc }, { ...zlib }] },
  };
}

test('[PB10] parity: a consistent world passes', () => {
  assert.deepEqual(parity(world()), []);
});

test('[PB10] parity: a CVE-free package omitted from the inventory fails (identities are compared, not only findings)', () => {
  const w = world();
  w.inventory.components = w.inventory.components.filter((c) => c.name !== 'zlib1g');
  has(parity(w), /zlib1g.* is in Grype's catalogue of the image but not in the inventory/);
});

test("[PB10] parity: a CVE-free package dropped or changed in Grype's INGESTED catalogue fails (owner's probes)", () => {
  let w = world();
  w.inventoryCatalogue.components = w.inventoryCatalogue.components.filter(
    (c) => c.name !== 'zlib1g',
  );
  has(parity(w), /zlib1g.* is in the inventory but not in the catalogue Grype ingested/);
  w = world();
  w.inventoryCatalogue.components[2] = deb('zlib1g', '1:1.3-1+b1', 'zlib@1:1.2-9'); // source version changed
  has(
    parity(w),
    /zlib1g\|1:1\.3-1\+b1\|amd64\|zlib\|1:1\.3-1\|debian-13\.7 is in the inventory but not in the catalogue Grype ingested/,
  );
  w = world();
  w.inventoryCatalogue.components[2] = {
    ...deb('zlib1g', '1:1.3-1+b1', 'zlib@1:1.3-1'),
    purl: deb('zlib1g', '1:1.3-1+b1', 'zlib@1:1.3-1').purl.replace('debian-13.7', 'debian-12'),
  };
  has(parity(w), /is in the catalogue Grype ingested but not in the inventory/); // distro kept, not normalised away
});

test('[PB10] parity: a wrong version or source, or a finding on only one side, fails', () => {
  let w = world();
  w.inventory.components[1] = deb('libc6', '2.40-1', 'glibc');
  has(
    parity(w),
    /libc6\|2\.41-12\+deb13u4\|amd64\|glibc\|\|debian-13\.7 is in Grype's catalogue of the image but not in the inventory/,
  );
  w = world();
  w.inventory.components[1] = deb('libc6', '2.41-12+deb13u4'); // the source dropped: Grype would match nothing
  has(
    parity(w),
    /libc6\|2\.41-12\+deb13u4\|amd64\|libc6\|\|debian-13\.7 is in the inventory but not in Grype's catalogue of the image/,
  );
  w = world();
  w.inventoryScan.matches = [];
  has(
    parity(w),
    /Grype finds libc6\|2\.41-12\+deb13u4\|CVE-2026-5435 on the image but not on the inventory/,
  );
});

test("[PB10] parity: PgBouncer's actual CPE field is checked, never text elsewhere in the component (owner's probe)", () => {
  let w = world();
  w.inventoryCatalogue.components[0] = {
    ...pgb('1.26.0'),
    cpe: 'cpe:2.3:a:other:pgbouncer:1.26.0:*:*:*:*:*:*:*',
    properties: [{ name: 'note', value: CPE }],
  };
  has(parity(w), /Grype ingested PgBouncer 1\.26\.0 with CPE cpe:2\.3:a:other/);
  w = world();
  w.inventory.components = w.inventory.components.filter((c) => c.name !== 'pgbouncer');
  has(parity(w), /0 PgBouncer components, expected 1/);
  w = world();
  w.inventory.components[0].cpe = 'cpe:2.3:a:other:pgbouncer:1.26.0:*:*:*:*:*:*:*';
  has(parity(w), /PgBouncer CPE is cpe:2\.3:a:other/);
  w = world();
  w.inventoryCatalogue.components = w.inventoryCatalogue.components.filter(
    (c) => c.name !== 'pgbouncer',
  );
  has(parity(w), /Grype ingested 0 PgBouncer components, expected 1/);
  w = world();
  w.imageCatalogue.components.push({ name: 'pgbouncer', version: '1.26.0' });
  has(parity(w), /catalogue of the image found a PgBouncer package/);
  w = world();
  w.imageCatalogue.components = [];
  has(parity(w), /Grype's catalogue of the image has no Debian packages/);
});

test('[PB10] binding: Grype and Trivy evidence must be of the scanned image', () => {
  const saved = { configDigest: 'sha256:c0', diffIds: ['sha256:l1', 'sha256:l2'] };
  const grypeImageScan = { source: { target: { imageID: 'sha256:c0' } } };
  const trivy = { Metadata: { ImageID: 'sha256:id', DiffIDs: ['sha256:l1', 'sha256:l2'] } };
  assert.deepEqual(bindingProblems({ imageId: 'sha256:id', saved, grypeImageScan, trivy }), []);
  assert.deepEqual(
    bindingProblems({
      imageId: 'sha256:id',
      saved,
      grypeImageScan,
      trivy: { Metadata: { ...trivy.Metadata, ImageID: 'sha256:c0' } },
    }),
    [],
  ); // classic store
  has(
    bindingProblems({
      imageId: 'sha256:id',
      saved,
      grypeImageScan: { source: { target: { imageID: 'sha256:other' } } },
      trivy,
    }),
    /Grype's image scan is of sha256:other/,
  );
  has(
    bindingProblems({
      imageId: 'sha256:id',
      saved,
      grypeImageScan,
      trivy: { Metadata: { ...trivy.Metadata, ImageID: 'sha256:other' } },
    }),
    /Trivy report is for image sha256:other/,
  );
  has(
    bindingProblems({
      imageId: 'sha256:id',
      saved,
      grypeImageScan,
      trivy: { Metadata: { ...trivy.Metadata, DiffIDs: ['sha256:l1'] } },
    }),
    /Trivy report's layers/,
  );
});

// ---------- the runner, with Docker, the verifier and the archive reader mocked ----------

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
/** A mocked Docker that answers every call the gate makes; `over` replaces answers by command kind. */
function mockDocker(work, over = {}) {
  const calls = [];
  const w = world();
  const answers = {
    inspect: () => ({ status: 0, stdout: `${IMAGE_ID}\n` }),
    update: () => ({ status: 0, stdout: '' }),
    status: () => ({
      status: 0,
      stdout: JSON.stringify(status({ built: new Date(NOW - 3_600_000).toISOString() })),
    }),
    reader: () => ({ status: 0, stdout: JSON.stringify({ digest: 'xxh64:0ebdf559edec4ee5' }) }),
    save: () => ({ status: 0, stdout: '' }),
    scan: (args) => {
      const out = (kind) =>
        args
          .find((a) => a.startsWith(`${kind}=`))
          ?.split('=')[1]
          .replace('/work/', '');
      const inv = args.includes('sbom:/work/inventory.cdx.json');
      writeFileSync(
        join(work, out('json')),
        JSON.stringify(
          inv ? w.inventoryScan : { ...w.imageScan, source: { target: { imageID: 'sha256:c0' } } },
        ),
      );
      writeFileSync(
        join(work, out('cyclonedx-json')),
        JSON.stringify(inv ? w.inventoryCatalogue : w.imageCatalogue),
      );
      return { status: 0, stdout: '' };
    },
    ...over,
  };
  const run = (args) => {
    let kind;
    if (args[0] === 'image') kind = 'inspect';
    else if (args[0] === 'save') kind = 'save';
    else if (args.includes(READER_IMAGE)) kind = 'reader';
    else if (args.includes(GRYPE_IMAGE) && args.includes('update')) kind = 'update';
    else if (args.includes(GRYPE_IMAGE) && args.includes('status')) kind = 'status';
    else kind = 'scan';
    calls.push(kind);
    return { cmd: kind, stderr: '', ...answers[kind](args) };
  };
  return { run, calls, world: w };
}

async function gateWith({ docker = {}, verify = async () => [], trivy } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'uv-gate-'));
  try {
    const m = mockDocker(join(work, 'ev'), docker); // the scans write into the gate's evidence directory
    writeFileSync(join(work, 'in.cdx.json'), JSON.stringify(m.world.inventory));
    writeFileSync(
      join(work, 'trivy.json'),
      JSON.stringify(
        trivy ?? { Metadata: { ImageID: IMAGE_ID, DiffIDs: ['sha256:l1'] }, Results: [] },
      ),
    );
    const result = await runGate({
      image: 'univarse-pgbouncer:ci',
      inventoryPath: join(work, 'in.cdx.json'),
      trivyPath: join(work, 'trivy.json'),
      evidenceDir: join(work, 'ev'),
      now: NOW,
      deps: {
        run: m.run,
        verifyInventory: verify,
        readSavedImage: async () => ({ configDigest: 'sha256:c0', diffIds: ['sha256:l1'] }),
      },
    });
    return { ...result, calls: m.calls };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('[PB10] runner: the clean control passes with every step run', async () => {
  const r = await gateWith();
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls, ['inspect', 'update', 'status', 'reader', 'save', 'scan', 'scan']);
});

test("[PB10] runner: the import.json reader's exit status is required, even when it prints valid JSON (owner's probe)", async () => {
  const r = await gateWith({
    docker: {
      reader: () => ({ status: 17, stdout: JSON.stringify({ digest: 'xxh64:0ebdf559edec4ee5' }) }),
    },
  });
  assert.equal(r.ok, false);
  has(r.problems, /reading \/cache\/6\/import\.json failed \(exit 17\)/);
});

test('[PB10] runner: the inventory is verified against the resolved image before the database is touched', async () => {
  let verifiedId;
  const r = await gateWith({
    verify: async (id) => {
      verifiedId = id;
      return ['the binary reports PgBouncer 1.25.0, but the image declares 1.26.0'];
    },
  });
  assert.equal(verifiedId, IMAGE_ID); // the immutable ID, never the tag
  assert.equal(r.ok, false);
  has(r.problems, /inventory: the binary reports PgBouncer 1\.25\.0/);
  assert.deepEqual(r.calls, ['inspect']); // nothing else ran
});

test('[PB10] runner: an unresolvable image, or evidence of another image, fails', async () => {
  let r = await gateWith({ docker: { inspect: () => ({ status: 1, stdout: '' }) } });
  has(r.problems, /can't resolve univarse-pgbouncer:ci to an immutable image ID/);
  r = await gateWith({
    trivy: {
      Metadata: { ImageID: `sha256:${'b'.repeat(64)}`, DiffIDs: ['sha256:l1'] },
      Results: [],
    },
  });
  has(r.problems, /Trivy report is for image sha256:b/);
  r = await gateWith({
    docker: { update: () => ({ status: 1, stdout: '', stderr: 'unreachable' }) },
  });
  has(r.problems, /grype db update failed \(exit 1\)/);
  assert.deepEqual(r.calls, ['inspect', 'update']); // stopped at the update
});
