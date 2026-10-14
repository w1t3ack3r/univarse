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
import { join, posix } from 'node:path';
import { REPO } from './release-lib.mjs';
import { consumeDockerExport } from './tar.mjs';

export const DOCKERFILE = 'infra/docker/pgbouncer.Dockerfile';
export const LIBEVENT_PKG = 'libevent-2.1-7t64';
const STATUS_DIR = 'var/lib/dpkg/status.d/';
const BINARY = 'usr/bin/pgbouncer';
const DEBIAN_VERSION = 'etc/debian_version';

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
    adns: /^adns: (\S+)/m.exec(text)?.[1], // its first word: `evdns2`, or `c-ares` followed by a version
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

/** libevent's soname link, the only link the build adds; its target must be one of libevent's listed files. */
export const LIBEVENT_LINKS = ['usr/lib/x86_64-linux-gnu/libevent-2.1.so.7'];
const SUPPORTED_TYPES = new Set(['file', 'dir', 'symlink']);
const validHashes = (f) =>
  !!f && /^[0-9a-f]{64}$/.test(f.sha256 ?? '') && /^[0-9a-f]{32}$/.test(f.md5 ?? '');
/** path (without a trailing slash) → entry. */
const entryMap = (entries) =>
  new Map(
    entries.map((e) => [e.path.replace(/\/$/, ''), { ...e, path: e.path.replace(/\/$/, '') }]),
  );

/**
 * Where an image's package records and its files disagree: `deviations` maps `pkg:path` → 'absent' | 'differs from
 * its listed md5'. `problems` are records that can't be read or list nothing.
 */
export function recordDeviations(records, files) {
  const deviations = new Map();
  const problems = [];
  for (const pkg of Object.keys(records).sort()) {
    let listed;
    try {
      listed = parseMd5sums(records[pkg].md5sums ?? '');
    } catch (e) {
      problems.push(`the ${pkg} file list is unreadable: ${e.message}`);
      continue;
    }
    if (listed.length === 0) problems.push(`the ${pkg} record lists no files`);
    for (const { md5, path } of listed) {
      const f = files[path];
      if (!f) deviations.set(`${pkg}:${path}`, 'absent');
      else if (f.md5 !== md5) deviations.set(`${pkg}:${path}`, 'differs from its listed md5');
    }
  }
  return { deviations, problems };
}

/**
 * Every PB10 tie and inventory check that doesn't need the inventory file itself.
 * `facts`: { imageId, labels, versionOutput, records: { pkg: { control, md5sums } }, files: { path: { sha256, md5 } },
 *            entries: [{ path, type, link? }] }; `base`: { records, files, entries } from the pinned runtime base image; `pins` from
 *            the Dockerfile.
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
  }

  // Every entry is a supported kind, and every regular file carries valid hashes. Hardlinks are rejected rather than
  // resolved: neither the base nor the build produces any, so one would be unexplained.
  for (const e of facts.entries) {
    if (!SUPPORTED_TYPES.has(e.type))
      problems.push(
        `${e.path} is a ${e.type} entry: only regular files, directories and symlinks are supported`,
      );
    else if (e.type === 'file' && !validHashes(facts.files[e.path]))
      problems.push(`${e.path} has no valid SHA-256 and md5`);
  }

  // The base is preserved byte for byte: every file of the pinned base image is in the final image, unchanged.
  // (Removing or altering a base library fails here, whatever its package record says.)
  for (const [path, f] of Object.entries(base.files)) {
    const g = facts.files[path];
    if (!g) problems.push(`${path}, a file of the base image, is missing from the final image`);
    else if (g.sha256 !== f.sha256) problems.push(`${path} differs from the base image's copy`);
  }
  // ...and so is every base entry's kind and every base link's target.
  const finalEntries = entryMap(facts.entries);
  for (const b of entryMap(base.entries ?? []).values()) {
    const f = finalEntries.get(b.path);
    if (!f)
      problems.push(`${b.path}, a ${b.type} of the base image, is missing from the final image`);
    else if (f.type !== b.type)
      problems.push(`${b.path} is a ${f.type}, but the base image has a ${b.type}`);
    else if (b.type === 'symlink' && f.link !== b.link)
      problems.push(
        `${b.path} links to ${f.link ?? '(nothing)'}, but the base image's link points to ${b.link}`,
      );
  }
  // Only the expected additions: PgBouncer; libevent's listed files, its record, and its soname link to one of its
  // listed files; and the directories holding them. Nothing else.
  const libeventFiles = new Set();
  try {
    for (const { path } of parseMd5sums(facts.records[LIBEVENT_PKG]?.md5sums ?? ''))
      libeventFiles.add(path);
  } catch {
    // reported below
  }
  const allowed = new Set([
    BINARY,
    `${STATUS_DIR}${LIBEVENT_PKG}`,
    `${STATUS_DIR}${LIBEVENT_PKG}.md5sums`,
    ...libeventFiles,
  ]);
  const baseEntries = entryMap(base.entries ?? []);
  const addedDirsAllowed = new Set();
  for (const p of [...allowed, ...LIBEVENT_LINKS])
    for (let d = posix.dirname(p); d !== '.' && d !== '/'; d = posix.dirname(d))
      addedDirsAllowed.add(d);
  for (const e of facts.entries) {
    if (baseEntries.has(e.path.replace(/\/$/, '')) || base.files[e.path]) continue;
    if (e.type === 'file') {
      if (!allowed.has(e.path))
        problems.push(
          `${e.path} is in the image but is neither a base file nor an expected addition`,
        );
    } else if (e.type === 'symlink') {
      const target = e.link ? posix.normalize(posix.join(posix.dirname(e.path), e.link)) : '';
      if (!LIBEVENT_LINKS.includes(e.path))
        problems.push(
          `${e.path} is a link in the image that is neither the base's nor an expected addition`,
        );
      else if (!libeventFiles.has(target))
        problems.push(
          `${e.path} links to ${e.link ?? '(nothing)'}, which isn't one of ${LIBEVENT_PKG}'s files`,
        );
    } else if (e.type === 'dir' && !addedDirsAllowed.has(e.path.replace(/\/$/, ''))) {
      problems.push(`${e.path} is a directory in the image that holds no expected addition`);
    }
  }
  for (const l of LIBEVENT_LINKS)
    if (finalEntries.get(l)?.type !== 'symlink')
      problems.push(`${l}, libevent's soname link, is missing`);
  // Records against files. libevent's record must match its files exactly. The base's own records may deviate from
  // its files (distroless ships only the CA bundle, and its own os-release), but only exactly as the pinned base
  // does: any new deviation is a problem.
  const baseDev = recordDeviations(base.records, base.files);
  const finalDev = recordDeviations(facts.records, facts.files);
  for (const d of finalDev.problems) problems.push(d);
  for (const [key, why] of finalDev.deviations) {
    if (key.startsWith(`${LIBEVENT_PKG}:`))
      problems.push(
        `${key.slice(LIBEVENT_PKG.length + 1)}: ${why}, against its ${LIBEVENT_PKG} record`,
      );
    else if (baseDev.deviations.get(key) !== why)
      problems.push(`${key}: ${why}, which the base image doesn't do`);
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

/** A file's SHA-256, which must be present and well formed: the inventory is never written with a gap. */
const sha256Of = (f, path) => {
  if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? ''))
    throw new Error(`${path}'s hash is missing or invalid: the inventory would be incomplete`);
  return f.sha256;
};

const required = (v, what) => {
  if (v === undefined || v === null || v === '')
    throw new Error(`${what} is missing: the inventory would be incomplete`);
  return v;
};

/** The CycloneDX inventory: every package record, plus PgBouncer with its CPE and hashes. Deterministic; it throws
 * rather than leave anything out. */
export function buildInventory(facts, pins) {
  const distroVersion = required(facts.files[DEBIAN_VERSION]?.text, DEBIAN_VERSION);
  const pkgComponents = Object.keys(facts.records)
    .sort()
    .map((pkg) => {
      const c = parseControl(facts.records[pkg].control);
      const listed = parseMd5sums(facts.records[pkg].md5sums ?? '');
      return {
        'bom-ref': `deb:${pkg}`,
        type: 'library',
        name: pkg,
        version: c.Version,
        purl: debPurl(c, distroVersion),
        // Every listed file, explicitly. A shipped file gets its hash, and if its bytes differ from the record's md5 that
        // is marked too; a file the image doesn't ship is marked absent. (checkFacts has confirmed any such deviation is
        // the pinned base's own.) Nothing is silently left out.
        properties: listed.flatMap(({ md5, path }) => {
          const f = facts.files[path];
          if (!f)
            return [
              {
                name: `univarse:file-absent:${path}`,
                value: 'listed by the record, not shipped by the base image',
              },
            ];
          const hash = { name: `univarse:file-sha256:${path}`, value: sha256Of(f, path) };
          return f.md5 === md5
            ? [hash]
            : [
                hash,
                {
                  name: `univarse:file-md5-differs-from-record:${path}`,
                  value: 'shipped as the pinned base image ships it, not as its record lists',
                },
              ];
        }),
      };
    });
  // Every other regular file, and every symlink with its target: so no file of the image is missing from its inventory.
  const owned = new Set([BINARY]);
  for (const pkg of Object.keys(facts.records))
    for (const { path } of parseMd5sums(facts.records[pkg].md5sums ?? '')) owned.add(path);
  const entries = [...facts.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const imageFiles = {
    'bom-ref': 'image-files',
    type: 'data',
    name: 'univarse-pgbouncer image files and links owned by no package',
    properties: [
      ...entries
        .filter((e) => e.type === 'file' && !owned.has(e.path))
        .map((e) => ({
          name: `univarse:file-sha256:${e.path}`,
          value: sha256Of(facts.files[e.path], e.path),
        })),
      ...entries
        .filter((e) => e.type === 'symlink')
        .map((e) => ({
          name: `univarse:symlink:${e.path.replace(/\/$/, '')}`,
          value: required(e.link, `${e.path}'s link target`),
        })),
    ],
  };
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
        hashes: [{ alg: 'SHA-256', content: sha256Of(facts.files[BINARY], BINARY) }],
        externalReferences: [
          {
            type: 'distribution',
            url: `https://www.pgbouncer.org/downloads/files/${version}/pgbouncer-${version}.tar.gz`,
            hashes: [{ alg: 'SHA-256', content: pins.sourceSha256 }],
          },
        ],
      },
      ...pkgComponents,
      imageFiles,
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

/**
 * Reads an image from `docker export`: its package records, every entry's path and type, and (with `hashFiles`) the
 * SHA-256 and md5 of EVERY regular file, base files included, so each package's files can be checked against its
 * record. `image` must be an immutable reference (an image ID).
 */
async function readImage(image, { hashFiles = true } = {}) {
  // Created, never started: the placeholder command only satisfies images with no default command (distroless).
  const id = docker(['create', image, '/nonexistent']).trim();
  const records = {};
  const files = {};
  const entries = [];
  const want = (p) => hashFiles || p.startsWith(STATUS_DIR) || p === DEBIAN_VERSION;
  const onEntry = (e) => {
    const path = e.path.replace(/^\.?\//, '');
    entries.push({ path, type: e.type, ...(e.link !== undefined ? { link: e.link } : {}) });
    // The parser collects no data for an empty file: hash it as the empty buffer it is.
    const data =
      e.data ?? (e.type === 'file' && e.size === 0 && want(path) ? Buffer.alloc(0) : null);
    if (!data) return;
    // Every file is hashed, package records included; records are also parsed.
    files[path] = {
      sha256: createHash('sha256').update(data).digest('hex'),
      md5: createHash('md5').update(data).digest('hex'),
    };
    if (path === DEBIAN_VERSION) files[path].text = data.toString('utf8').trim();
    if (path.startsWith(STATUS_DIR)) {
      const name = path.slice(STATUS_DIR.length);
      const pkg = name.replace(/\.md5sums$/, '');
      records[pkg] ??= {};
      records[pkg][name.endsWith('.md5sums') ? 'md5sums' : 'control'] = data.toString('utf8');
    }
  };
  try {
    // A malformed or truncated export rejects (consumeTar): no partial inventory is ever produced.
    await consumeDockerExport(
      id,
      onEntry,
      { wantData: (p) => want(p.replace(/^\.?\//, '')) },
      { spawn },
    );
  } finally {
    docker(['rm', id]);
  }
  return { records, files, entries };
}

/** Facts about an image, read through its resolved, immutable ID throughout: inspection, export and the probe. */
export async function gatherFacts(image) {
  const [meta] = JSON.parse(docker(['image', 'inspect', image]));
  const id = meta.Id;
  const { records, files, entries } = await readImage(id);
  const versionOutput = docker(['run', '--rm', '--network', 'none', id, '--version']);
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
  // The base is pinned by digest, so a local copy IS the pinned image: pull only when it isn't here (a registry
  // round-trip on every run made the check depend on the network for nothing).
  if (spawnSync('docker', ['image', 'inspect', baseImage], { encoding: 'utf8' }).status !== 0)
    docker(['pull', '-q', baseImage]);
  const [meta] = JSON.parse(docker(['image', 'inspect', baseImage]));
  const { records, files, entries } = await readImage(meta.Id);
  return { records, files, entries };
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
