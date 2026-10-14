// Spec 0017 PB10: the PgBouncer image's complete runtime inventory, and the tie check that binds it to the actual
// build. Nothing here trusts what the image *claims*: facts are read from the final image itself (its files, its
// package records, and the versions its binary reports) and compared with the declared metadata and the pins.
//
//   node tools/images/pgbouncer-inventory.mjs generate <image> <out.cdx.json>   facts → checks → CycloneDX inventory
//   node tools/images/pgbouncer-inventory.mjs verify   <image> <inventory.json> facts → checks → inventory must match
//
// A check never passes on missing data: an absent record, file, label or version is a problem, not a skip.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './release-lib.mjs';
import { tarParser } from './tar.mjs';

export const DOCKERFILE = 'infra/docker/pgbouncer.Dockerfile';
export const LIBEVENT_PKG = 'libevent-2.1-7t64';
const STATUS_DIR = 'var/lib/dpkg/status.d/';
const BINARY = 'usr/bin/pgbouncer';
const DEBIAN_VERSION = 'etc/debian_version';
const LIBEVENT_PATHS = [
  /^usr\/lib\/x86_64-linux-gnu\/libevent/,
  /^usr\/share\/doc\/libevent-/,
  /^usr\/share\/lintian\/overrides\/libevent-/,
];

// ---------- pure parsing ----------

/** A dpkg control paragraph → { field: value } (continuation lines folded in). */
export function parseControl(text) {
  const out = {};
  let key = null;
  for (const line of text.split('\n')) {
    if (/^\s/.test(line) && key) out[key] += `\n${line}`;
    else {
      const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
      if (m) {
        key = m[1];
        out[key] = m[2];
      }
    }
  }
  return out;
}

/** A dpkg md5sums file → [{ md5, path }]; a malformed line throws. */
export function parseMd5sums(text) {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^([0-9a-f]{32}) {2}(\S.*)$/.exec(l);
      if (!m) throw new Error(`malformed md5sums line: ${JSON.stringify(l)}`);
      return { md5: m[1], path: m[2] };
    });
}

/** The upstream part of a Debian version: no epoch, no Debian revision (`1:2.1.13-stable-1~deb13u1` → `2.1.13-stable`). */
export function debianUpstream(version) {
  const noEpoch = version.replace(/^\d+:/, '');
  const i = noEpoch.lastIndexOf('-');
  return i > 0 ? noEpoch.slice(0, i) : noEpoch;
}

/** `pgbouncer --version` output → { pgbouncer, libevent, adns }; anything unrecognised stays undefined. */
export function parseVersionOutput(text) {
  return {
    pgbouncer: /^PgBouncer (\S+)$/m.exec(text)?.[1],
    libevent: /^libevent (\S+)$/m.exec(text)?.[1],
    adns: /^adns: (\S+)$/m.exec(text)?.[1],
  };
}

/** The pins in the Dockerfile: the runtime base, the PgBouncer version and its tarball's SHA-256. */
export function dockerfilePins(text) {
  const arg = (name) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(text)?.[1];
  return {
    runtimeImage: arg('RUNTIME_IMAGE'),
    version: arg('PGBOUNCER_VERSION'),
    sourceSha256: arg('PGBOUNCER_SHA256'),
  };
}

export const pgbouncerCpe = (version) => `cpe:2.3:a:pgbouncer:pgbouncer:${version}:*:*:*:*:*:*:*`;

// ---------- the checks (pure: facts in, problems out) ----------

/**
 * Every PB10 tie and inventory check that doesn't need the inventory file itself.
 * `facts`: { imageId, labels, versionOutput, records: { pkg: { control, md5sums } }, files: { path: { sha256, md5 } },
 *            entries: [{ path, type }] }; `base`: { records } from the runtime base image; `pins` from the Dockerfile.
 */
export function checkFacts(facts, base, pins) {
  const problems = [];
  const reported = parseVersionOutput(facts.versionOutput ?? '');
  const declared = facts.labels?.['org.univarse.pgbouncer.version'];
  const declaredSha = facts.labels?.['org.univarse.pgbouncer.source-sha256'];

  // PgBouncer: the version the binary reports is the version declared, which is the version pinned.
  if (!reported.pgbouncer) problems.push('the binary reported no PgBouncer version');
  if (!declared) problems.push('label org.univarse.pgbouncer.version is missing');
  if (reported.pgbouncer && declared && reported.pgbouncer !== declared)
    problems.push(
      `the binary reports PgBouncer ${reported.pgbouncer}, but the image declares ${declared}`,
    );
  if (declared && pins.version && declared !== pins.version)
    problems.push(
      `the image declares PgBouncer ${declared}, but the Dockerfile pins ${pins.version}`,
    );
  if (declaredSha !== pins.sourceSha256)
    problems.push(
      `the image declares source SHA-256 ${declaredSha ?? '(none)'}, but the Dockerfile pins ${pins.sourceSha256}`,
    );
  if (reported.adns !== 'evdns2')
    problems.push(
      `DNS is "${reported.adns ?? '(unreported)'}", expected libevent's evdns2 (no c-ares)`,
    );
  if (!facts.files[BINARY]) problems.push(`${BINARY} is missing from the image`);
  if (!/^\d+\.\d+$/.test(facts.files[DEBIAN_VERSION]?.text ?? ''))
    problems.push(`${DEBIAN_VERSION} is missing or not a Debian point release`);

  // The base's inventory is preserved: the same records, byte for byte, plus libevent's and nothing else.
  const finalPkgs = Object.keys(facts.records).sort();
  const basePkgs = Object.keys(base.records).sort();
  const expected = [...basePkgs, LIBEVENT_PKG].sort();
  if (JSON.stringify(finalPkgs) !== JSON.stringify(expected))
    problems.push(
      `package records are [${finalPkgs.join(', ')}], expected the base's plus ${LIBEVENT_PKG}: [${expected.join(', ')}]`,
    );
  for (const pkg of basePkgs) {
    const a = base.records[pkg];
    const b = facts.records[pkg];
    if (b && (a.control !== b.control || a.md5sums !== b.md5sums))
      problems.push(`the base's record for ${pkg} was changed`);
  }

  // libevent: its record, its files and the version the binary reports all agree.
  const rec = facts.records[LIBEVENT_PKG];
  if (!rec) problems.push(`no package record for ${LIBEVENT_PKG}`);
  else {
    const control = parseControl(rec.control);
    if (control.Package !== LIBEVENT_PKG)
      problems.push(`the ${LIBEVENT_PKG} record names package "${control.Package ?? ''}"`);
    if (!control.Version) problems.push(`the ${LIBEVENT_PKG} record has no version`);
    else if (reported.libevent !== debianUpstream(control.Version))
      problems.push(
        `the binary reports libevent ${reported.libevent ?? '(none)'}, but the ${LIBEVENT_PKG} record's version is ${control.Version} (upstream ${debianUpstream(control.Version)})`,
      );
    let listed = [];
    try {
      listed = parseMd5sums(rec.md5sums ?? '');
    } catch (e) {
      problems.push(`the ${LIBEVENT_PKG} file list is unreadable: ${e.message}`);
    }
    if (listed.length === 0) problems.push(`the ${LIBEVENT_PKG} record lists no files`);
    for (const { md5, path } of listed) {
      const f = facts.files[path];
      if (!f) problems.push(`${LIBEVENT_PKG} lists ${path}, which isn't in the image`);
      else if (f.md5 !== md5)
        problems.push(`${path} doesn't match the md5 its ${LIBEVENT_PKG} record lists`);
    }
    const listedSet = new Set(listed.map((l) => l.path));
    for (const e of facts.entries) {
      if (
        e.type === 'file' &&
        LIBEVENT_PATHS.some((re) => re.test(e.path)) &&
        !listedSet.has(e.path)
      )
        problems.push(`${e.path} is in the image but not in the ${LIBEVENT_PKG} record`);
    }
  }
  return problems;
}

/**
 * The package URL Grype's own cataloguer writes for a dpkg record: the binary package, its version, and the SOURCE
 * package as `upstream` (Debian advisories are per source package: libc6 → glibc, zlib1g → zlib), with the exact
 * distro version. Without `upstream`, Grype silently matches nothing for most packages.
 */
export function debPurl(control, distroVersion) {
  const q = [`arch=${control.Architecture ?? 'all'}`, `distro=debian-${distroVersion}`];
  const src = /^(\S+)(?: \((\S+)\))?$/.exec(control.Source ?? '');
  if (src && (src[1] !== control.Package || src[2]))
    q.push(`upstream=${encodeURIComponent(src[2] ? `${src[1]}@${src[2]}` : src[1])}`);
  return `pkg:deb/debian/${control.Package}@${encodeURIComponent(control.Version)}?${q.join('&')}`;
}

/** The CycloneDX inventory: every package record, plus PgBouncer with its CPE and hashes. Deterministic. */
export function buildInventory(facts, pins) {
  const distroVersion = facts.files[DEBIAN_VERSION]?.text;
  const pkgComponents = Object.keys(facts.records)
    .sort()
    .map((pkg) => {
      const c = parseControl(facts.records[pkg].control);
      const files = parseMd5sums(facts.records[pkg].md5sums ?? '').map((l) => l.path);
      return {
        'bom-ref': `deb:${pkg}`,
        type: 'library',
        name: pkg,
        version: c.Version,
        purl: debPurl(c, distroVersion),
        properties: files
          .filter((p) => facts.files[p])
          .map((p) => ({ name: `univarse:file-sha256:${p}`, value: facts.files[p].sha256 })),
      };
    });
  const version = facts.labels?.['org.univarse.pgbouncer.version'];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'container', name: 'univarse-pgbouncer', version: facts.imageId },
      properties: [{ name: 'univarse:image-id', value: facts.imageId }],
    },
    components: [
      {
        'bom-ref': 'pgbouncer',
        type: 'application',
        name: 'pgbouncer',
        version,
        cpe: pgbouncerCpe(version),
        purl: `pkg:generic/pgbouncer@${version}`,
        hashes: [{ alg: 'SHA-256', content: facts.files[BINARY]?.sha256 }],
        externalReferences: [
          {
            type: 'distribution',
            url: `https://www.pgbouncer.org/downloads/files/${version}/pgbouncer-${version}.tar.gz`,
            hashes: [{ alg: 'SHA-256', content: pins.sourceSha256 }],
          },
        ],
      },
      ...pkgComponents,
    ],
  };
}

/** Inventory-file checks: it must be exactly what the image's facts produce (so no edited or partial inventory passes). */
export function checkInventory(inventory, facts, pins) {
  const problems = [];
  const want = buildInventory(facts, pins);
  const pg = (inventory.components ?? []).filter((c) => c.name === 'pgbouncer');
  if (pg.length !== 1)
    problems.push(`the inventory has ${pg.length} PgBouncer components, expected exactly 1`);
  else {
    const c = pg[0];
    if (!c.version) problems.push("the inventory's PgBouncer component has no version");
    if (c.cpe !== pgbouncerCpe(c.version ?? ''))
      problems.push(
        `the inventory's PgBouncer CPE is ${c.cpe ?? '(none)'}, expected ${pgbouncerCpe(c.version ?? '<version>')}`,
      );
  }
  if (inventory.metadata?.component?.version !== facts.imageId)
    problems.push(
      `the inventory is for image ${inventory.metadata?.component?.version ?? '(none)'}, not ${facts.imageId}`,
    );
  if (JSON.stringify(inventory) !== JSON.stringify(want))
    problems.push("the inventory differs from what the image's own facts produce");
  return problems;
}

// ---------- gathering facts from Docker ----------

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** Reads an image's records, the files we hash, and every entry's path and type, from `docker export`. */
async function readImage(image, { hashAll = true } = {}) {
  // Created, never started: the placeholder command only satisfies images with no default command (distroless).
  const id = docker(['create', image, '/nonexistent']).trim();
  const records = {};
  const files = {};
  const entries = [];
  const want = (p) =>
    p.startsWith(STATUS_DIR) ||
    p === DEBIAN_VERSION ||
    (hashAll && (p === BINARY || LIBEVENT_PATHS.some((re) => re.test(p))));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['export', id]);
      const parser = tarParser(
        (e) => {
          const path = e.path.replace(/^\.?\//, '');
          entries.push({ path, type: e.type });
          if (!e.data) return;
          if (path.startsWith(STATUS_DIR)) {
            const name = path.slice(STATUS_DIR.length);
            const pkg = name.replace(/\.md5sums$/, '');
            records[pkg] ??= {};
            records[pkg][name.endsWith('.md5sums') ? 'md5sums' : 'control'] =
              e.data.toString('utf8');
          } else {
            files[path] = {
              sha256: createHash('sha256').update(e.data).digest('hex'),
              md5: createHash('md5').update(e.data).digest('hex'),
            };
            if (path === DEBIAN_VERSION) files[path].text = e.data.toString('utf8').trim();
          }
        },
        { wantData: (p) => want(p.replace(/^\.?\//, '')) },
      );
      child.stdout.on('data', (c) => parser.push(c));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`docker export exited ${code}`)),
      );
    });
  } finally {
    docker(['rm', id]);
  }
  return { records, files, entries };
}

export async function gatherFacts(image) {
  const [meta] = JSON.parse(docker(['image', 'inspect', image]));
  const { records, files, entries } = await readImage(image);
  const versionOutput = docker(['run', '--rm', '--network', 'none', image, '--version']);
  return {
    imageId: meta.Id,
    labels: meta.Config?.Labels ?? {},
    versionOutput,
    records,
    files,
    entries,
  };
}

export async function gatherBase(baseImage) {
  docker(['pull', '-q', baseImage]);
  const { records } = await readImage(baseImage, { hashAll: false });
  return { records };
}

async function main() {
  const [cmd, image, file] = process.argv.slice(2);
  if (!['generate', 'verify'].includes(cmd) || !image || !file) {
    console.error('usage: pgbouncer-inventory.mjs generate|verify <image> <inventory.json>');
    process.exit(2);
  }
  const pins = dockerfilePins(readFileSync(join(REPO, DOCKERFILE), 'utf8'));
  const facts = await gatherFacts(image);
  const base = await gatherBase(pins.runtimeImage);
  const problems = checkFacts(facts, base, pins);
  if (cmd === 'generate' && problems.length === 0)
    writeFileSync(file, `${JSON.stringify(buildInventory(facts, pins), null, 2)}\n`);
  if (cmd === 'verify')
    problems.push(...checkInventory(JSON.parse(readFileSync(file, 'utf8')), facts, pins));
  const reported = parseVersionOutput(facts.versionOutput);
  console.log(
    `[inventory] image ${facts.imageId}: PgBouncer ${reported.pgbouncer ?? '?'}, libevent ${reported.libevent ?? '?'}, ${Object.keys(facts.records).length} package records, binary sha256 ${facts.files[BINARY]?.sha256 ?? '?'}`,
  );
  if (problems.length > 0) {
    for (const p of problems) console.error(`[inventory] FAIL: ${p}`);
    process.exit(1);
  }
  console.log(`[inventory] ${cmd === 'generate' ? `wrote ${file}` : `${file} matches the image`}`);
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
) {
  main().catch((e) => {
    console.error(`[inventory] ERROR: ${e.message}`);
    process.exit(1);
  });
}
