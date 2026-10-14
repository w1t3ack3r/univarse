// Spec 0017 PB10: the Grype gate for the PgBouncer image. Scanner responsibility is fixed by provenance (owner
// decision 2026-10-14): genuine Debian packages are gated by Trivy (spec 0013's gate, vendor-aware severity); the
// source-built PgBouncer, which Trivy can't see, is gated HERE through Grype's CPE match. Never by whichever scanner
// reports the lower severity.
//
//   node tools/images/pgbouncer-grype-gate.mjs <image> <inventory.cdx.json> <trivy.json> <evidence-dir> [--cache <volume|dir>]
//
// The database is checked first and fails the gate on its own: one successful update check per run (downloading
// when needed), then a status that must exit 0 and report a valid, fresh database. Every scan reuses that database.
// Grype's matches on the inventory must equal its matches on the image itself, and the Debian package identities must
// be equal too (parity), so the inventory can't silently lose coverage.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configOf } from './gates.mjs';
import {
  checkFacts,
  checkInventory,
  DOCKERFILE,
  dockerfilePins,
  gatherBase,
  gatherFacts,
} from './pgbouncer-inventory.mjs';
import { hostPath, REPO } from './release-lib.mjs';
import { readFromTar } from './tar.mjs';

export const GRYPE_IMAGE =
  'anchore/grype:v0.120.1@sha256:e4a44ef45d285b829ce6efe2642980329661bd2d18eab5fc539138d4adaebbbe';
/** Reads the database's import metadata out of a cache volume (the distroless Node runtime the API image pins). */
export const READER_IMAGE =
  'gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e';
export const MAX_DB_AGE_MS = 48 * 60 * 60 * 1000;
/** Every scan reuses the one checked database: no updates, age and hash validated. */
export const SCAN_ENV = {
  GRYPE_DB_AUTO_UPDATE: 'false',
  GRYPE_DB_VALIDATE_AGE: 'true',
  GRYPE_DB_MAX_ALLOWED_BUILT_AGE: '48h',
  GRYPE_DB_VALIDATE_BY_HASH_ON_START: 'true',
};
const BLOCKING = new Set(['Critical', 'High']);

// ---------- pure: database ----------

/** `grype db status -o json` (its exit status already checked) → problems. */
export function checkDbStatus(status, now = Date.now(), maxAgeMs = MAX_DB_AGE_MS) {
  const problems = [];
  if (!status || typeof status !== 'object') return ['grype db status returned no JSON object'];
  if (status.valid !== true)
    problems.push(
      `the database is not valid (valid: ${JSON.stringify(status.valid)}${status.error ? `, error: ${status.error}` : ''})`,
    );
  const built = Date.parse(status.built ?? '');
  if (Number.isNaN(built))
    problems.push(
      `the database's built time is missing or unparseable (${JSON.stringify(status.built)})`,
    );
  else if (now - built > maxAgeMs)
    problems.push(
      `the database was built ${status.built}, more than ${maxAgeMs / 3_600_000} h ago`,
    );
  else if (built - now > 60 * 60 * 1000)
    problems.push(`the database's built time ${status.built} is in the future`);
  if (!/^v\d+\.\d+\.\d+$/.test(status.schemaVersion ?? ''))
    problems.push(
      `the database's schemaVersion is missing or malformed (${JSON.stringify(status.schemaVersion)})`,
    );
  if (typeof status.path !== 'string' || !status.path.endsWith('/vulnerability.db'))
    problems.push(`the database path is missing (${JSON.stringify(status.path)})`);
  return problems;
}

/** The installed database's `import.json` → its digest (`xxh64:…`), or a problem. */
export function importDigest(importJson) {
  const d = importJson?.digest;
  return /^xxh64:[0-9a-f]{16}$/.test(d ?? '')
    ? { digest: d }
    : { problem: `import.json has no valid xxh64 digest (${JSON.stringify(d)})` };
}

// ---------- pure: routing, disagreements, parity ----------

/** A component's provenance, from its purl (or the PgBouncer CPE): 'debian' | 'pgbouncer' | null (unroutable). */
export function provenance(artifact) {
  const purl = artifact?.purl ?? '';
  if (purl.startsWith('pkg:deb/debian/')) return 'debian';
  if (artifact?.name === 'pgbouncer' && purl.startsWith('pkg:generic/pgbouncer@'))
    return 'pgbouncer';
  return null;
}

/**
 * Routes every Grype match on the inventory by provenance. `blocking`: PgBouncer findings at HIGH/CRITICAL (this gate
 * fails on them). `routedToTrivy`: Debian package findings (Trivy gates those; kept as evidence). Anything unroutable
 * is a problem: fail closed.
 */
export function routeFindings(report) {
  const blocking = [];
  const routedToTrivy = [];
  const problems = [];
  for (const m of report?.matches ?? []) {
    const p = provenance(m.artifact);
    const f = {
      id: m.vulnerability?.id,
      severity: m.vulnerability?.severity,
      name: m.artifact?.name,
      version: m.artifact?.version,
    };
    if (p === 'pgbouncer') {
      if (BLOCKING.has(f.severity)) blocking.push(f);
    } else if (p === 'debian') routedToTrivy.push(f);
    else
      problems.push(
        `a finding on ${f.name}@${f.version} (${m.artifact?.purl ?? 'no purl'}) has no routing: refused`,
      );
  }
  return { blocking, routedToTrivy, problems };
}

/** Where Grype and Trivy rate the same CVE on the same package differently (recorded, never used for routing). */
export function disagreements(grypeReport, trivyReport) {
  const trivy = new Map();
  for (const r of trivyReport?.Results ?? [])
    for (const v of r.Vulnerabilities ?? [])
      trivy.set(`${v.PkgName} ${v.VulnerabilityID}`, v.Severity);
  const out = [];
  for (const m of grypeReport?.matches ?? []) {
    if (provenance(m.artifact) !== 'debian') continue;
    const key = `${m.artifact.name} ${m.vulnerability.id}`;
    const t = trivy.get(key);
    const g = m.vulnerability.severity?.toUpperCase();
    if (t !== g)
      out.push({
        package: m.artifact.name,
        id: m.vulnerability.id,
        grype: g,
        trivy: t ?? '(not reported)',
      });
  }
  return out.sort((a, b) => `${a.package} ${a.id}`.localeCompare(`${b.package} ${b.id}`));
}

/**
 * Debian identity from a deb purl, nothing normalised away: name, version, arch, source package AND its version
 * (`upstream=name@version`), and the distro qualifier.
 */
export function debIdentity(purl) {
  const m = /^pkg:deb\/debian\/([^@]+)@([^?]+)\?(.*)$/.exec(purl ?? '');
  if (!m) return null;
  const q = new URLSearchParams(m[3]);
  const upstream = q.get('upstream');
  const at = upstream ? upstream.indexOf('@') : -1;
  return {
    name: m[1],
    version: decodeURIComponent(m[2]),
    arch: q.get('arch'),
    source: upstream ? (at >= 0 ? upstream.slice(0, at) : upstream) : m[1],
    sourceVersion: upstream && at >= 0 ? upstream.slice(at + 1) : null,
    distro: q.get('distro'),
  };
}
const idKey = (i) =>
  `${i.name}|${i.version}|${i.arch}|${i.source}|${i.sourceVersion ?? ''}|${i.distro}`;
const debIds = (components) =>
  new Set(
    (components ?? [])
      .map((c) => debIdentity(c.purl))
      .filter(Boolean)
      .map(idKey),
  );
const debFindings = (report) =>
  new Set(
    (report?.matches ?? [])
      .filter((m) => provenance(m.artifact) === 'debian')
      .map((m) => `${m.artifact.name}|${m.artifact.version}|${m.vulnerability.id}`),
  );
const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/**
 * Parity: the inventory loses no coverage, compared across THREE views of the same packages:
 *   the input inventory, the catalogue Grype ingested from it, and Grype's own catalogue of the image.
 * The Debian portion: package identities (name, version, arch, source and source version, distro) are equal in all
 * three, so a package Grype silently dropped or changed while ingesting, even one with no CVEs, fails; and Grype's
 * Debian findings are equal on inventory and image.
 * PgBouncer, separately: exactly one inventory component, whose `cpe` FIELD is the expected CPE; Grype's ingested
 * catalogue has that component with the same `cpe` field; and the image catalogue has none (Grype can't see it).
 */
export function parity({
  inventory,
  inventoryScan,
  inventoryCatalogue,
  imageScan,
  imageCatalogue,
}) {
  const problems = [];
  const views = {
    inventory: debIds(inventory?.components),
    'the catalogue Grype ingested': debIds(inventoryCatalogue?.components),
    "Grype's catalogue of the image": debIds(imageCatalogue?.components),
  };
  for (const [name, ids] of Object.entries(views))
    if (ids.size === 0) problems.push(`${name} has no Debian packages: parity can't be shown`);
  const base = views.inventory;
  for (const [name, ids] of Object.entries(views)) {
    if (ids === base) continue;
    for (const k of diff(base, ids))
      problems.push(`Debian package ${k} is in the inventory but not in ${name}`);
    for (const k of diff(ids, base))
      problems.push(`Debian package ${k} is in ${name} but not in the inventory`);
  }
  const invF = debFindings(inventoryScan);
  const imgF = debFindings(imageScan);
  for (const k of diff(imgF, invF))
    problems.push(`Grype finds ${k} on the image but not on the inventory`);
  for (const k of diff(invF, imgF))
    problems.push(`Grype finds ${k} on the inventory but not on the image`);

  const pg = (inventory?.components ?? []).filter((c) => c.name === 'pgbouncer');
  if (pg.length !== 1)
    problems.push(`the inventory has ${pg.length} PgBouncer components, expected 1`);
  else {
    const want = `cpe:2.3:a:pgbouncer:pgbouncer:${pg[0].version}:*:*:*:*:*:*:*`;
    if (pg[0].cpe !== want)
      problems.push(`the inventory's PgBouncer CPE is ${pg[0].cpe}, expected ${want}`);
    const ingested = (inventoryCatalogue?.components ?? []).filter((c) => c.name === 'pgbouncer');
    if (ingested.length !== 1)
      problems.push(`Grype ingested ${ingested.length} PgBouncer components, expected 1`);
    else if (ingested[0].version !== pg[0].version || ingested[0].cpe !== want)
      problems.push(
        `Grype ingested PgBouncer ${ingested[0].version} with CPE ${ingested[0].cpe ?? '(none)'}, expected ${pg[0].version} with ${want}`,
      );
  }
  if ((imageCatalogue?.components ?? []).some((c) => c.name === 'pgbouncer'))
    problems.push(
      "Grype's own catalogue of the image found a PgBouncer package: the CPE route's premise has changed, review it",
    );
  return problems;
}

// ---------- the run ----------

function realRun(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const out = {
    cmd: `docker ${args.join(' ')}`,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
  if (!allowFail && r.status !== 0)
    throw Object.assign(
      new Error(`${out.cmd} exited ${r.status}: ${out.stderr.trim().slice(-400)}`),
      { out },
    );
  return out;
}

/** The real inventory verifier: facts from the image (by its immutable ID) against the given inventory snapshot. */
async function realVerifyInventory(imageId, inventory) {
  const pins = dockerfilePins(readFileSync(join(REPO, DOCKERFILE), 'utf8'));
  const facts = await gatherFacts(imageId);
  if (facts.imageId !== imageId)
    return [`the inventory verifier read image ${facts.imageId}, not ${imageId}`];
  const base = await gatherBase(pins.runtimeImage);
  return [...checkFacts(facts, base, pins), ...checkInventory(inventory, facts, pins)];
}

/** The saved archive's image identity: its config digest (checked against the blob's own hash) and its layer IDs. */
async function realReadSavedImage(tarPath) {
  const manifest = JSON.parse((await readFromTar(tarPath, 'manifest.json')).toString('utf8'));
  const configDigest = configOf(manifest);
  const blob = await readFromTar(tarPath, manifest[0].Config);
  if (!blob) throw new Error(`the saved archive has no config blob ${manifest[0].Config}`);
  const actual = `sha256:${createHash('sha256').update(blob).digest('hex')}`;
  if (actual !== configDigest)
    throw new Error(`the saved config's bytes hash to ${actual}, not ${configDigest}`);
  return { configDigest, diffIds: JSON.parse(blob.toString('utf8')).rootfs?.diff_ids ?? [] };
}

/**
 * Binds the evidence to ONE image: Grype's image scan names the saved config digest, and the Trivy report has exactly
 * the saved layers and an image ID that is this image's (Docker's ID or the config digest, depending on the store).
 */
export function bindingProblems({ imageId, saved, grypeImageScan, trivy }) {
  const problems = [];
  const gid = grypeImageScan?.source?.target?.imageID;
  if (gid !== saved.configDigest)
    problems.push(`Grype's image scan is of ${gid ?? '(unknown)'}, not ${saved.configDigest}`);
  const tid = trivy?.Metadata?.ImageID;
  if (tid !== imageId && tid !== saved.configDigest)
    problems.push(`the Trivy report is for image ${tid ?? '(unknown)'}, not ${imageId}`);
  if (JSON.stringify(trivy?.Metadata?.DiffIDs ?? null) !== JSON.stringify(saved.diffIds))
    problems.push("the Trivy report's layers aren't the scanned image's layers");
  return problems;
}

/**
 * The gate. `cache`: a docker volume name or a host directory holding the Grype database. `extraEnv` lets the coverage
 * controls point the update at an unreachable URL or tighten the age. `deps` replaces Docker, the inventory verifier
 * and the archive reader in tests. Returns { ok, problems, evidence }.
 */
export async function runGate({
  image,
  inventoryPath,
  trivyPath,
  evidenceDir,
  cache = 'uv-grype-cache',
  extraEnv = {},
  now = Date.now(),
  deps = {},
}) {
  const run = deps.run ?? realRun;
  const verifyInventory = deps.verifyInventory ?? realVerifyInventory;
  const readSavedImage = deps.readSavedImage ?? realReadSavedImage;
  mkdirSync(evidenceDir, { recursive: true });
  const work = resolve(evidenceDir);
  const cacheMount = /[\\/]/.test(cache) ? `${hostPath(resolve(cache))}:/cache` : `${cache}:/cache`;
  const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const grype = (args, env) =>
    run(
      [
        'run',
        '--rm',
        '-v',
        cacheMount,
        '-v',
        `${hostPath(work)}:/work`,
        '-e',
        'GRYPE_DB_CACHE_DIR=/cache',
        ...envArgs({ ...env, ...extraEnv }),
        GRYPE_IMAGE,
        ...args,
      ],
      { allowFail: true },
    );
  const evidence = { grypeImage: GRYPE_IMAGE, commands: [] };
  const step = (r) => {
    evidence.commands.push({ cmd: r.cmd, status: r.status });
    return r;
  };
  // Every outcome leaves its evidence, failures included: what ran, with what result, and why it stopped.
  const record = (problems) =>
    writeFileSync(
      join(work, 'grype-gate-evidence.json'),
      `${JSON.stringify({ ...evidence, problems }, null, 2)}\n`,
    );
  const fail = (problems) => {
    record(problems);
    return { ok: false, problems, evidence };
  };

  // 0. One immutable image, and one inventory snapshot: resolved and read ONCE, before anything else. Everything below
  //    uses the image ID (never the tag) and these exact inventory bytes.
  const inspected = step(
    run(['image', 'inspect', '--format', '{{.Id}}', image], { allowFail: true }),
  );
  const imageId = inspected.stdout.trim();
  if (inspected.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId))
    return fail([`can't resolve ${image} to an immutable image ID (exit ${inspected.status})`]);
  evidence.image = { reference: image, id: imageId };
  const snapshot = readFileSync(inventoryPath);
  let inventory;
  try {
    inventory = JSON.parse(snapshot.toString('utf8'));
  } catch {
    return fail([`${inventoryPath} is not JSON`]);
  }
  writeFileSync(join(work, 'inventory.cdx.json'), snapshot); // Grype scans exactly these bytes
  evidence.inventorySha256 = createHash('sha256').update(snapshot).digest('hex');

  // 1. The inventory is verified against that exact image: its source-built PgBouncer is exactly what image
  //    cataloguing misses, so package parity alone could never bind it.
  const inventoryProblems = await verifyInventory(imageId, inventory);
  if (inventoryProblems.length) return fail(inventoryProblems.map((p) => `inventory: ${p}`));

  // 2. One successful update check per run, downloading when necessary. Its failure stops the gate here.
  const update = step(grype(['db', 'update'], { GRYPE_DB_REQUIRE_UPDATE_CHECK: 'true' }));
  if (update.status !== 0)
    return fail([
      `grype db update failed (exit ${update.status}): ${update.stderr.trim().slice(-300)}`,
    ]);

  // 3. The status must exit 0 AND report a valid, fresh database; the output supplements the exit status.
  const status = step(grype(['db', 'status', '-o', 'json'], SCAN_ENV));
  if (status.status !== 0)
    return fail([
      `grype db status failed (exit ${status.status}): ${status.stderr.trim().slice(-300)}`,
    ]);
  let statusJson;
  try {
    statusJson = JSON.parse(status.stdout);
  } catch {
    return fail(['grype db status -o json printed no JSON']);
  }
  const dbProblems = checkDbStatus(statusJson, now);
  if (dbProblems.length) return fail(dbProblems);
  evidence.database = {
    built: statusJson.built,
    schemaVersion: statusJson.schemaVersion,
    source: statusJson.from,
  };

  // 4. The installed database's digest, from its import.json. Grype writes its database directory 0700 as root, so the
  //    reader runs as root but can only read: read-only mount, no network, no capabilities, read-only root filesystem.
  //    Its successful exit is required before its output is believed.
  const importPath = statusJson.path.replace(/vulnerability\.db$/, 'import.json');
  const imp = step(
    run(
      [
        'run',
        '--rm',
        '--user',
        '0:0',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--read-only',
        '-v',
        `${cacheMount}:ro`,
        READER_IMAGE,
        '-e',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(importPath)}))`,
      ],
      { allowFail: true },
    ),
  );
  if (imp.status !== 0) return fail([`reading ${importPath} failed (exit ${imp.status})`]);
  let digest;
  try {
    digest = importDigest(JSON.parse(imp.stdout));
  } catch {
    digest = { problem: `import.json at ${importPath} is not JSON` };
  }
  if (digest.problem) return fail([digest.problem]);
  evidence.database.digest = digest.digest;

  // 5. The image itself, saved by its ID, and its identity read from the archive.
  const saved = step(run(['save', imageId, '-o', join(work, 'image.tar')], { allowFail: true }));
  if (saved.status !== 0) return fail([`docker save ${imageId} failed (exit ${saved.status})`]);
  let savedImage;
  try {
    savedImage = await readSavedImage(join(work, 'image.tar'));
  } catch (e) {
    return fail([`the saved image is unreadable: ${e.message}`]);
  }
  evidence.image.configDigest = savedImage.configDigest;

  // 6. The scans, both on the one checked database.
  const scans = {
    inventory: step(
      grype(
        [
          'sbom:/work/inventory.cdx.json',
          '-o',
          'json=/work/grype-inventory.json',
          '-o',
          'cyclonedx-json=/work/grype-inventory.cdx.json',
        ],
        SCAN_ENV,
      ),
    ),
    image: step(
      grype(
        [
          'docker-archive:/work/image.tar',
          '-o',
          'json=/work/grype-image.json',
          '-o',
          'cyclonedx-json=/work/grype-image.cdx.json',
        ],
        SCAN_ENV,
      ),
    ),
  };
  for (const [name, r] of Object.entries(scans))
    if (r.status !== 0)
      return fail([`the ${name} scan failed (exit ${r.status}): ${r.stderr.trim().slice(-300)}`]);
  const read = (f) => JSON.parse(readFileSync(join(work, f), 'utf8'));
  const inventoryScan = read('grype-inventory.json');
  const imageScan = read('grype-image.json');
  const trivy = JSON.parse(readFileSync(trivyPath, 'utf8'));

  // 7. Binding, parity, routing, disclosure.
  const problems = [
    ...bindingProblems({ imageId, saved: savedImage, grypeImageScan: imageScan, trivy }),
    ...parity({
      inventory,
      inventoryScan,
      inventoryCatalogue: read('grype-inventory.cdx.json'),
      imageScan,
      imageCatalogue: read('grype-image.cdx.json'),
    }),
  ];
  const routed = routeFindings(inventoryScan);
  problems.push(...routed.problems);
  for (const f of routed.blocking)
    problems.push(
      `PgBouncer ${f.version}: ${f.id} is ${f.severity} (blocking under the declared policy)`,
    );
  evidence.blocking = routed.blocking;
  evidence.routedToTrivy = routed.routedToTrivy;
  evidence.disagreements = disagreements(inventoryScan, trivy);
  evidence.grypeSeverityCounts = Object.fromEntries(
    ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'].map((s) => [
      s,
      inventoryScan.matches.filter((m) => m.vulnerability.severity === s).length,
    ]),
  );
  evidence.componentHashes = (inventory.components ?? [])
    .filter((c) => c.name === 'pgbouncer')
    .map((c) => ({ name: c.name, version: c.version, hashes: c.hashes }));
  writeFileSync(
    join(work, 'grype-gate-evidence.json'),
    `${JSON.stringify({ ...evidence, problems }, null, 2)}\n`,
  );
  return { ok: problems.length === 0, problems, evidence };
}

function summary({ ok, problems, evidence }) {
  const lines = [];
  if (evidence.database)
    lines.push(
      `[grype-gate] database built ${evidence.database.built}, schema ${evidence.database.schemaVersion}, digest ${evidence.database.digest ?? '?'}`,
    );
  if (evidence.grypeSeverityCounts) {
    const c = evidence.grypeSeverityCounts;
    lines.push(
      `[grype-gate] Grype's full report on the inventory: ${c.Critical} CRITICAL, ${c.High} HIGH, ${c.Medium} MEDIUM, ${c.Low} LOW, ${c.Negligible} negligible`,
    );
    lines.push(
      `[grype-gate] routing by provenance: ${evidence.blocking.length} blocking PgBouncer finding(s) here; ${evidence.routedToTrivy.length} Debian package finding(s) gated by Trivy`,
    );
    for (const d of evidence.disagreements)
      lines.push(
        `[grype-gate] severity disagreement: ${d.package} ${d.id}: Grype ${d.grype}, Trivy ${d.trivy}`,
      );
  }
  if (ok)
    lines.push(
      '[grype-gate] PASS: zero blocking HIGH/CRITICAL under the declared policy (Grype gates PgBouncer by CPE; Trivy gates Debian packages)',
    );
  else for (const p of problems) lines.push(`[grype-gate] FAIL: ${p}`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const cache = opt('cache') ?? 'uv-grype-cache';
  const [image, inventoryPath, trivyPath, evidenceDir] = args;
  if (!image || !inventoryPath || !trivyPath || !evidenceDir) {
    console.error(
      'usage: pgbouncer-grype-gate.mjs <image> <inventory.cdx.json> <trivy.json> <evidence-dir> [--cache <volume|dir>]',
    );
    process.exit(2);
  }
  const result = await runGate({ image, inventoryPath, trivyPath, evidenceDir, cache });
  console.log(summary(result));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[grype-gate] ERROR: ${e.message}`);
    process.exit(1);
  });
}
