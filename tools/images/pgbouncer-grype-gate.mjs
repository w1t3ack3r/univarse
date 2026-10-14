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

/** The config fields that define how the image runs: compared between Docker's view and the saved archive. */
const CONFIG_FIELDS = ['User', 'Entrypoint', 'Cmd', 'Env', 'Labels', 'ExposedPorts', 'WorkingDir'];
/** Canonical JSON (sorted keys; absent and empty treated alike) for comparing configs from different sources. */
function canonical(v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
    return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (keys.length === 0) return null;
    return Object.fromEntries(keys.map((k) => [k, canonical(v[k])]));
  }
  return v;
}
const configSubset = (config) =>
  canonical(Object.fromEntries(CONFIG_FIELDS.map((k) => [k, config?.[k]])));
const platformOf = (p) => `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ''}`;

/**
 * The image's EXPECTED identity, established independently of any archive: from `docker image inspect` of the
 * resolved ID. Its platform (selected explicitly, never "the first one saved"), its layer IDs, its run config, and
 * which image store produced the ID: the containerd store's ID is an index or manifest digest, so it legitimately
 * differs from the config digest; the classic store's ID IS the config digest.
 */
export function expectedIdentity(inspect) {
  const m = Array.isArray(inspect) ? inspect[0] : inspect;
  if (
    !m?.Id ||
    !m.Os ||
    !m.Architecture ||
    !Array.isArray(m.RootFS?.Layers) ||
    m.RootFS.Layers.length === 0
  )
    throw new Error(
      "docker image inspect gave no ID, platform or layers: the image's identity can't be established",
    );
  const media = m.Descriptor?.mediaType ?? '';
  return {
    id: m.Id,
    platform: { os: m.Os, architecture: m.Architecture, variant: m.Variant ?? null },
    layers: m.RootFS.Layers,
    config: configSubset(m.Config),
    idIsConfigDigest: !/image\.index|manifest/.test(media),
  };
}

/**
 * Binds the evidence to ONE image, the expected one:
 *   the saved archive holds exactly one image, of the expected platform, with exactly the expected layers and config
 *   (and, on the classic store, a config digest equal to the image ID); Grype's image scan names that archive's config
 *   digest; and the Trivy report has exactly the expected layers and this image's ID (Docker's ID or the config digest).
 * A coherent substitute (archive and both reports all of another image B) fails: B's layers aren't A's.
 */
export function bindingProblems({ expected, saved, grypeImageScan, trivy }) {
  const problems = [];
  if (saved.images !== 1)
    problems.push(`the saved archive holds ${saved.images} images, expected exactly 1`);
  const savedPlatform = {
    os: saved.os,
    architecture: saved.architecture,
    variant: saved.variant ?? null,
  };
  if (platformOf(savedPlatform) !== platformOf(expected.platform))
    problems.push(
      `the saved image is ${platformOf(savedPlatform)}, not the expected ${platformOf(expected.platform)}`,
    );
  if (JSON.stringify(saved.diffIds) !== JSON.stringify(expected.layers))
    problems.push("the saved image's layers aren't the expected image's layers");
  if (JSON.stringify(configSubset(saved.config)) !== JSON.stringify(expected.config))
    problems.push("the saved image's run config isn't the expected image's");
  if (expected.idIsConfigDigest && saved.configDigest !== expected.id)
    problems.push(
      `the saved config is ${saved.configDigest}, but this store's image ID ${expected.id} is the config digest`,
    );
  const gid = grypeImageScan?.source?.target?.imageID;
  if (gid !== saved.configDigest)
    problems.push(`Grype's image scan is of ${gid ?? '(unknown)'}, not ${saved.configDigest}`);
  const tid = trivy?.Metadata?.ImageID;
  if (tid !== expected.id && tid !== saved.configDigest)
    problems.push(`the Trivy report is for image ${tid ?? '(unknown)'}, not ${expected.id}`);
  if (JSON.stringify(trivy?.Metadata?.DiffIDs ?? null) !== JSON.stringify(expected.layers))
    problems.push("the Trivy report's layers aren't the expected image's layers");
  return problems;
}

/** The saved archive: how many images it holds, and the one image's config digest (checked against its bytes), layers,
 * platform and config. */
async function realReadSavedImage(tarPath) {
  const raw = await readFromTar(tarPath, 'manifest.json');
  if (!raw) throw new Error('the saved archive has no manifest.json');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0)
    throw new Error('the saved archive lists no images');
  const configDigest = configOf(manifest);
  const blob = await readFromTar(tarPath, manifest[0].Config);
  if (!blob) throw new Error(`the saved archive has no config blob ${manifest[0].Config}`);
  const actual = `sha256:${createHash('sha256').update(blob).digest('hex')}`;
  if (actual !== configDigest)
    throw new Error(`the saved config's bytes hash to ${actual}, not ${configDigest}`);
  const cfg = JSON.parse(blob.toString('utf8'));
  return {
    images: manifest.length,
    configDigest,
    diffIds: cfg.rootfs?.diff_ids ?? [],
    os: cfg.os,
    architecture: cfg.architecture,
    variant: cfg.variant ?? null,
    config: cfg.config ?? {},
  };
}

/**
 * The gate. `cache`: a docker volume name or a host directory holding the Grype database. `extraEnv` lets the coverage
 * controls point the update at an unreachable URL or tighten the age. `deps` replaces Docker, the inventory verifier
 * and the archive reader in tests. Returns { ok, problems, evidence }; an unexpected error is caught here, recorded
 * with the stage it happened in and the commands already run, and returned as a failure.
 */
export async function runGate(opts) {
  mkdirSync(opts.evidenceDir, { recursive: true }); // if this fails, nothing can be recorded: let it throw
  const work = resolve(opts.evidenceDir);
  const ctx = { stage: 'start', evidence: { grypeImage: GRYPE_IMAGE, commands: [] } };
  const record = (problems, extra = {}) =>
    writeFileSync(
      join(work, 'grype-gate-evidence.json'),
      `${JSON.stringify({ ...ctx.evidence, ...extra, problems }, null, 2)}\n`,
    );
  try {
    const result = await gate(opts, work, ctx, record);
    record(result.problems, { stage: ctx.stage });
    return result;
  } catch (e) {
    const problems = [`unexpected error during ${ctx.stage}: ${e.message}`];
    try {
      record(problems, { stage: ctx.stage, error: { name: e.name, message: e.message } });
    } catch {
      // the evidence directory itself failed: the nonzero result still stands
    }
    return { ok: false, problems, evidence: ctx.evidence };
  }
}

async function gate(
  {
    image,
    inventoryPath,
    trivyPath,
    cache = 'uv-grype-cache',
    extraEnv = {},
    now = Date.now(),
    deps = {},
  },
  work,
  ctx,
  record,
) {
  const run = deps.run ?? realRun;
  const verifyInventory = deps.verifyInventory ?? realVerifyInventory;
  const readSavedImage = deps.readSavedImage ?? realReadSavedImage;
  const { evidence } = ctx;
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
  const step = (r) => {
    evidence.commands.push({ cmd: r.cmd, status: r.status });
    return r;
  };
  const fail = (problems) => ({ ok: false, problems, evidence });
  const readJson = (file, what) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${what} is missing or not JSON (${e.message})`);
    }
  };

  // 0. One immutable image, with its expected identity, and one inventory snapshot: resolved and read ONCE. Everything
  //    below uses the image ID (never the tag), its explicit platform, and these exact inventory bytes.
  ctx.stage = 'resolving the image';
  const inspected = step(run(['image', 'inspect', image], { allowFail: true }));
  if (inspected.status !== 0)
    return fail([`can't resolve ${image} (docker image inspect exited ${inspected.status})`]);
  let expected;
  try {
    expected = expectedIdentity(JSON.parse(inspected.stdout));
  } catch (e) {
    return fail([`can't establish ${image}'s identity: ${e.message}`]);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expected.id))
    return fail([`${image} resolved to ${expected.id}, not an image digest`]);
  const imageId = expected.id;
  evidence.image = {
    reference: image,
    id: imageId,
    platform: platformOf(expected.platform),
    layers: expected.layers.length,
  };
  ctx.stage = 'reading the inventory';
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
  ctx.stage = 'verifying the inventory against the image';
  const inventoryProblems = await verifyInventory(imageId, inventory);
  if (inventoryProblems.length) return fail(inventoryProblems.map((p) => `inventory: ${p}`));

  // 2. One successful update check per run, downloading when necessary. Its failure stops the gate here.
  ctx.stage = 'updating the database';
  const update = step(grype(['db', 'update'], { GRYPE_DB_REQUIRE_UPDATE_CHECK: 'true' }));
  if (update.status !== 0)
    return fail([
      `grype db update failed (exit ${update.status}): ${update.stderr.trim().slice(-300)}`,
    ]);

  // 3. The status must exit 0 AND report a valid, fresh database; the output supplements the exit status.
  ctx.stage = 'checking the database status';
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
  ctx.stage = "reading the database's digest";
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

  // 5. The image itself, saved by its ID for its one explicit platform, and its identity read from the archive.
  ctx.stage = 'saving the image';
  const saved = step(
    run(
      ['save', '--platform', platformOf(expected.platform), imageId, '-o', join(work, 'image.tar')],
      { allowFail: true },
    ),
  );
  if (saved.status !== 0) return fail([`docker save ${imageId} failed (exit ${saved.status})`]);
  ctx.stage = 'reading the saved image';
  let savedImage;
  try {
    savedImage = await readSavedImage(join(work, 'image.tar'));
  } catch (e) {
    return fail([`the saved image is unreadable: ${e.message}`]);
  }
  evidence.image.configDigest = savedImage.configDigest;

  // 6. The scans, both on the one checked database.
  ctx.stage = 'scanning';
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
  ctx.stage = 'reading the scan reports';
  const inventoryScan = readJson(join(work, 'grype-inventory.json'), "Grype's inventory report");
  const imageScan = readJson(join(work, 'grype-image.json'), "Grype's image report");
  const inventoryCatalogue = readJson(
    join(work, 'grype-inventory.cdx.json'),
    "Grype's inventory catalogue",
  );
  const imageCatalogue = readJson(join(work, 'grype-image.cdx.json'), "Grype's image catalogue");
  const trivy = readJson(trivyPath, 'the Trivy report');

  // 7. Binding, parity, routing, disclosure.
  ctx.stage = 'judging';
  const problems = [
    ...bindingProblems({ expected, saved: savedImage, grypeImageScan: imageScan, trivy }),
    ...parity({ inventory, inventoryScan, inventoryCatalogue, imageScan, imageCatalogue }),
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
      (inventoryScan.matches ?? []).filter((m) => m.vulnerability.severity === s).length,
    ]),
  );
  evidence.componentHashes = (inventory.components ?? [])
    .filter((c) => c.name === 'pgbouncer')
    .map((c) => ({ name: c.name, version: c.version, hashes: c.hashes }));
  ctx.stage = 'done';
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
