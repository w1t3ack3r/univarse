// Spec 0013 LR8: the manual `pnpm images:prune`. Nothing is deleted automatically.
//
// TRUST MODEL. Release records are editable indexes: they may NOMINATE candidates, never authorise a deletion.
// What is kept, and what may go, is decided from what the registry holds and from signed provenance that verifies
// against the committed key (role, commit, rehearsal flag and start time are inside the signature):
//   • a "release" is a set of images whose verified provenance says rehearsal: false; the newest KEEP_RELEASES
//     (20) commits by their SIGNED start time are kept, whatever any record says;
//   • a record nominates only the exact tags release.mjs generates from its own commit, and only where the registry
//     agrees (the tag exists and points at the digest the record names). Anything else in a record is ignored;
//   • a nominated image is deleted only when it is positively classified as not kept: signed by the trusted key as
//     a rehearsal of the record's commit, signed as a release of the record's commit outside the 20, or
//     definitively NOT signed by the trusted key (cosign says so). Any other outcome protects the image;
//   • kept, always, with every signature and attestation of each (recursively): the kept releases; every digest
//     the local deploy runs or names for rollback (releases/deploy-state.json); every --keep pin; anything a tag
//     without a valid nomination still points at. Being untagged, or unknown, never makes an artifact eligible.
//
// cosign 3 on this registry (no OCI referrers API) stores a digest's signature and attestations as manifests
// listed in an index tagged `sha256-<hex>` (the OCI tag-schema fallback). Those are protected with their subject.
//
// EXCLUSION. `--apply` holds the registry lock (registry-lock.mjs, also held for the whole of every release and,
// when built, every deploy) for its whole run, and keeps the public registry (127.0.0.1:5000, alias registry:5000)
// offline for its whole run: it works through a private instance on the same storage, on a random loopback port and
// a private alias, so no other writer can reach the registry between planning and the final verification.
//
// Dry run by default. `--apply`: plan (under the lock, on the private instance), re-verify every kept release
// (refuse if one already fails), remove nominated tags, delete eligible manifests leaf-first, re-read the registry
// to prove every kept manifest survived, collect blobs WITHOUT --delete-untagged after a dry run proves no kept blob
// is eligible, re-verify every kept release, then restore the public registry as it was.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLE_SETS, ROLES, rolesOf } from './release-lib.mjs';

export const KEEP_RELEASES = 20;
const FALLBACK = /^sha256-([0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** The repositories releases push to (ROLES in release-lib.mjs), and the earliest rehearsals' negative-check repo. */
export const RELEASE_REPOS = Object.freeze(Object.fromEntries(Object.entries(ROLES).map(([role, r]) => [role, r.repo])));
/** The release role set exactly matching `names` (a record's, or a release's signed roles), or undefined. */
const roleSetOf = (names) => ROLE_SETS.find((set) => set.length === names.length && names.every((n) => set.includes(n)));
const LEGACY_UNSIGNED_REPO = 'univarse-unsigned-check';
export const fallbackTag = (digest) => `sha256-${digest.slice('sha256:'.length)}`;

/**
 * What one record may nominate: only the tags release.mjs generates from the record's own commit and rehearsal
 * flag. `subject` is the digest the tag must point at for the nomination to count (null: the tag may only be
 * removed; its digest is never deleted). A malformed record nominates nothing. The record's `refs` are not used.
 */
export function nominations(record) {
  if (!COMMIT.test(record?.commit ?? '') || typeof record.rehearsal !== 'boolean') return [];
  const base = `sha-${record.commit.slice(0, 7)}${record.rehearsal ? '-rehearsal' : ''}`;
  const out = [];
  // Only a record naming exactly one release role set (spec 0019: four roles; before it, api and web).
  const set = roleSetOf(Object.keys(record.images ?? {}));
  if (!set) return [];
  for (const role of set) {
    const repo = RELEASE_REPOS[role];
    const img = record.images?.[role];
    if (img?.repo !== repo || img.tag !== base || !DIGEST.test(img.digest ?? '')) return [];
    out.push({ repo, tag: base, subject: img.digest });
  }
  out.push(
    { repo: RELEASE_REPOS.api, tag: `role-swap-check-${base}`, subject: record.images.web.digest },
    { repo: RELEASE_REPOS.api, tag: `unsigned-check-${base}`, subject: null },
    { repo: LEGACY_UNSIGNED_REPO, tag: base, subject: null },
  );
  return out;
}

/**
 * Classifies one `cosign verify-attestation --type slsaprovenance1` result against the trusted key. Only cosign's
 * own definitive answers count as "not signed by the trusted key"; anything else (registry unreachable, a crash,
 * odd provenance) is "unknown", which protects the image.
 */
export function classify(result, predicatesFrom) {
  if (result.status === 0) {
    let statements;
    try {
      statements = predicatesFrom(result.stdout).map((p) => ({
        ...(p?.buildDefinition?.externalParameters ?? {}),
        startedOn: p?.runDetails?.metadata?.startedOn,
      }));
    } catch {
      return { kind: 'unknown', why: 'provenance did not parse' };
    }
    const s = statements[0];
    const consistent = new Set(statements.map((x) => `${x.commit}|${x.rehearsal}`)).size === 1;
    if (
      !s ||
      !consistent ||
      typeof s.rehearsal !== 'boolean' ||
      !COMMIT.test(s.commit ?? '') ||
      !s.startedOn
    ) {
      return { kind: 'unknown', why: 'signed provenance is missing, inconsistent or malformed' };
    }
    return {
      kind: s.rehearsal ? 'rehearsal' : 'release',
      commit: s.commit,
      role: s.role,
      startedOn: s.startedOn,
    };
  }
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (
    /no signatures found|no matching attestations|accepted signatures do not match threshold/.test(
      text,
    )
  ) {
    return { kind: 'unsigned', why: 'not signed by the trusted key' };
  }
  return {
    kind: 'unknown',
    why: (text.trim().split('\n').at(-1) || `cosign exited ${result.status}`).slice(0, 200),
  };
}

/** The kept release commits: the newest `keep` by their SIGNED start time. From signatures only, never records. */
export function keptCommits(trust, keep = KEEP_RELEASES) {
  const started = new Map();
  for (const t of Object.values(trust)) {
    if (t.kind !== 'release') continue;
    const prev = started.get(t.commit);
    if (!prev || t.startedOn > prev) started.set(t.commit, t.startedOn);
  }
  return new Set(
    [...started.entries()]
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .slice(0, keep)
      .map(([c]) => c),
  );
}

/**
 * The prune plan. Pure: no I/O.
 *   snapshot.repos[repo] = { tags: {tag: digest}, indexes: {indexDigest: [listedDigests]} }
 *   trust[`${repo}@${digest}`] = classify(...) for every tagged image in the release repositories
 *   records: release records (hints only); pins: [{repo, digest}] that must survive
 */
export function planPrune(snapshot, { records = [], trust = {}, pins = [], keep = KEEP_RELEASES }) {
  const plan = {
    untag: [],
    deleteManifests: [],
    kept: [],
    unowned: [],
    orphanedIndexes: [],
    ignored: [],
    live: {},
    keptCommits: [],
  };
  const kept = keptCommits(trust, keep);
  plan.keptCommits = [...kept];
  const trustOf = (repo, d) => trust[`${repo}@${d}`] ?? { kind: 'unknown', why: 'not classified' };
  const key = (repo, tag) => `${repo}\u0000${tag}`;

  // Validated nominations. A record of a kept release (its commit kept by signature, and not a rehearsal)
  // protects what it names instead; so does any nomination the registry contradicts.
  const removable = new Map();
  const protectedTags = new Set();
  for (const record of records) {
    const noms = nominations(record);
    if (noms.length === 0) {
      plan.ignored.push({
        record: record.file,
        why: 'not a well-formed release record; nominates nothing',
      });
      continue;
    }
    const recordKept = record.rehearsal === false && kept.has(record.commit);
    for (const n of noms) {
      const tags = snapshot.repos?.[n.repo]?.tags ?? {};
      if (!(n.tag in tags)) continue;
      const k = key(n.repo, n.tag);
      if (recordKept) {
        protectedTags.add(k);
      } else if (n.subject && tags[n.tag] !== n.subject) {
        plan.ignored.push({
          record: record.file,
          why: `${n.repo}:${n.tag} points at ${tags[n.tag]}, not the record's ${n.subject}`,
        });
        protectedTags.add(k);
      } else {
        removable.set(k, { record, subject: n.subject });
      }
    }
  }
  for (const k of protectedTags) removable.delete(k);

  for (const [repo, { tags = {}, indexes = {} }] of Object.entries(snapshot.repos ?? {}).sort()) {
    const isRemovable = (t) => removable.has(key(repo, t));
    const fallbackFor = (d) => tags[fallbackTag(d)];
    const live = new Set();
    // Everything a kept digest references: its own children when it is an index (e.g. a multi-platform image),
    // and its signature index with every signature and attestation listed there, all recursively.
    const close = (d) => {
      if (live.has(d)) return;
      live.add(d);
      for (const child of indexes[d] ?? []) close(child);
      const idx = fallbackFor(d);
      if (idx) close(idx);
    };
    // Roots: every tag nobody may remove; pins; and, from signatures alone, every image of a kept release
    // (including the role-swap copy in the api repository, which carries its web provenance).
    for (const [t, d] of Object.entries(tags)) if (!FALLBACK.test(t) && !isRemovable(t)) close(d);
    for (const p of pins) if (p.repo === repo) close(p.digest);
    for (const d of new Set(Object.values(tags))) {
      const tr = trust[`${repo}@${d}`];
      if (tr?.kind === 'release' && kept.has(tr.commit)) close(d);
    }

    const removableTags = Object.keys(tags)
      .filter((t) => !FALLBACK.test(t) && isRemovable(t))
      .sort();
    const subjects = new Map();
    for (const t of removableTags) {
      const { record, subject } = removable.get(key(repo, t));
      const d = tags[t];
      if (live.has(d) || subject !== d) continue; // kept, or a remove-only tag whose digest is never deleted
      const tr = trustOf(repo, d);
      const eligible =
        tr.kind === 'unsigned' ||
        (tr.kind === 'rehearsal' && tr.commit === record.commit) ||
        (tr.kind === 'release' && tr.commit === record.commit && !kept.has(tr.commit));
      if (!eligible) {
        plan.ignored.push({
          record: record.file,
          why: `${repo}@${d} kept: ${tr.kind}${tr.commit ? ` of ${tr.commit}` : ''}${tr.why ? ` (${tr.why})` : ''}`,
        });
        close(d);
        continue;
      }
      subjects.set(d, [...(subjects.get(d) ?? []), t]);
    }
    // Every signature index whose subject this plan does NOT delete is a root too, with all its descendants:
    // orphans (subject absent), and indexes of untouched images. A candidate an orphan index still lists becomes
    // kept (remove() skips anything kept; only its tags go). (Owner review of f2bdc2b.)
    for (const [t, idx] of Object.entries(tags)) {
      if (FALLBACK.test(t) && !subjects.has(`sha256:${FALLBACK.exec(t)[1]}`)) close(idx);
    }
    plan.live[repo] = live;
    // Nominated tags on a digest that stays, and remove-only tags (their digest is never deleted), are untagged.
    // (Tags on deleted digests go with the manifest.)
    for (const t of removableTags) {
      const { subject } = removable.get(key(repo, t));
      if (live.has(tags[t]) || subject === null) {
        const why = live.has(tags[t])
          ? 'nominated tag on a digest that is kept'
          : 'remove-only tag; its digest stays, untagged';
        plan.untag.push({ repo, tag: t, digest: tags[t], why });
      }
    }
    // Leaf-first: a subject's referrers, then its signature index, then the subject itself.
    const seen = new Set();
    const remove = (d, why) => {
      if (seen.has(d) || live.has(d)) return;
      seen.add(d);
      // A dropped index's own children go first, unless something kept also references them.
      for (const child of indexes[d] ?? []) remove(child, `child of ${d}`);
      const idx = fallbackFor(d);
      if (idx && !live.has(idx)) {
        for (const child of indexes[idx] ?? []) remove(child, `signature/attestation of ${d}`);
        if (!seen.has(idx)) {
          seen.add(idx);
          plan.deleteManifests.push({ repo, digest: idx, why: `signature index of ${d}` });
        }
      }
      plan.deleteManifests.push({ repo, digest: d, why });
    };
    for (const [d, ts] of [...subjects.entries()].sort())
      remove(d, `${trustOf(repo, d).kind} image (${ts.join(', ')})`);

    for (const [t, d] of Object.entries(tags).sort()) {
      if (FALLBACK.test(t)) {
        const subject = `sha256:${FALLBACK.exec(t)[1]}`;
        if (!live.has(subject) && !seen.has(subject))
          plan.orphanedIndexes.push({ repo, tag: t, digest: d });
      } else if (isRemovable(t)) continue;
      else if (protectedTags.has(key(repo, t))) plan.kept.push({ repo, tag: t, digest: d });
      else plan.unowned.push({ repo, tag: t, digest: d });
    }
  }
  // Defence in depth, independent of the logic above: the kept set is closed over every index's children, and
  // nothing kept, and no image of a kept release, is deleted.
  for (const [repo, live] of Object.entries(plan.live)) {
    for (const d of live) {
      for (const child of snapshot.repos[repo].indexes?.[d] ?? []) {
        if (!live.has(child))
          throw new Error(`prune plan keeps ${repo}@${d} but not its child ${child}; refusing`);
      }
    }
  }
  // Every signature index that survives keeps all of its descendants.
  const doomed = new Set(plan.deleteManifests.map((m) => `${m.repo}@${m.digest}`));
  for (const [repo, { tags = {}, indexes = {} }] of Object.entries(snapshot.repos ?? {})) {
    const stack = Object.entries(tags)
      .filter(([t, idx]) => FALLBACK.test(t) && !doomed.has(`${repo}@${idx}`))
      .map(([, idx]) => idx);
    const visited = new Set();
    while (stack.length) {
      const d = stack.pop();
      if (visited.has(d)) continue;
      visited.add(d);
      if (doomed.has(`${repo}@${d}`))
        throw new Error(
          `prune plan deletes ${repo}@${d}, which a surviving signature index references; refusing`,
        );
      stack.push(...(indexes[d] ?? []));
    }
  }
  for (const { repo, digest } of plan.deleteManifests) {
    const tr = trust[`${repo}@${digest}`];
    if (plan.live[repo].has(digest) || (tr?.kind === 'release' && kept.has(tr.commit))) {
      throw new Error(`prune plan would delete kept ${repo}@${digest}; refusing`);
    }
  }
  return plan;
}

/**
 * What to verify, for every kept release, built ONLY from trusted data: the digests whose provenance verified
 * against the committed key as a release of that commit, in that role's repository. Records are not consulted.
 * Every such digest is covered. A kept commit missing a role can't be verified: that is a problem, and `--apply`
 * refuses before deleting anything.
 */
export function verificationTargets(trust, keptCommits) {
  const targets = [];
  const problems = [];
  for (const c of keptCommits) {
    const byRole = {};
    for (const [role, repo] of Object.entries(RELEASE_REPOS)) {
      byRole[role] = Object.entries(trust)
        .filter(
          ([k, t]) =>
            k.startsWith(`${repo}@`) && t.kind === 'release' && t.commit === c && t.role === role,
        )
        .map(([k]) => k.slice(repo.length + 1))
        .sort();
    }
    // The smallest release role set covering the roles signed for this commit (spec 0019: a release from before it
    // holds api and web only); every role of that set must be signed.
    const signed = Object.keys(byRole).filter((r) => byRole[r].length > 0);
    const set = [...ROLE_SETS].sort((a, b) => a.length - b.length).find((s) => signed.every((r) => s.includes(r)));
    if (!set) {
      problems.push(`kept release ${c}: its signed roles (${signed.join(', ')}) match no release role set`);
      continue;
    }
    const missing = set.filter((role) => byRole[role].length === 0);
    for (const role of missing)
      problems.push(`kept release ${c}: no ${role} image signed for that role in ${RELEASE_REPOS[role]}`);
    if (missing.length) continue;
    // Each signed digest of each role, with the first digest of every other role, so every one is verified once.
    const seen = new Set();
    for (const role of set)
      for (const d of byRole[role]) {
        const pick = Object.fromEntries(set.map((r) => [r, r === role ? d : byRole[r][0]]));
        const key = set.map((r) => pick[r]).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
          file: `${c.slice(0, 7)} (from signed provenance)`,
          commit: c,
          rehearsal: false,
          roles: set,
          images: Object.fromEntries(set.map((r) => [r, { repo: RELEASE_REPOS[r], digest: pick[r] }])),
        });
      }
  }
  return { targets, problems };
}

/** Reads the deploy's state: current and rollback digests, which are always kept. Absent: nothing deployed yet. */
export function deployPins(file) {
  if (!existsSync(file)) return [];
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const pins = [...(state.current ?? []), ...(state.rollback ?? []).flat()];
  for (const p of pins)
    if (!p?.repo || !DIGEST.test(p.digest ?? ''))
      throw new Error(`${file}: every entry needs {repo, digest}`);
  return pins.map(({ repo, digest }) => ({ repo, digest }));
}

// ---------------------------------------------------------------- registry I/O and the CLI

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

function client(base) {
  return async function get(path, init = {}) {
    const r = await fetch(`${base}/v2${path}`, {
      ...init,
      headers: { accept: ACCEPT, ...init.headers },
    });
    if (!r.ok) throw new Error(`registry ${init.method ?? 'GET'} ${path} → ${r.status}`);
    return r;
  };
}

/** Every repository's tags (tag → digest), the contents of every signature index, and each manifest's blobs. */
export async function snapshotRegistry(base) {
  const get = client(base);
  const { repositories = [] } = await (await get('/_catalog?n=1000')).json();
  const repos = {};
  const blobs = {};
  const describe = async (repo, digest, manifest, entry) => {
    const k = `${repo}@${digest}`;
    if (blobs[k]) return;
    blobs[k] = [
      digest,
      manifest.config?.digest,
      ...(manifest.layers ?? []).map((l) => l.digest),
    ].filter(Boolean);
    if (Array.isArray(manifest.manifests)) {
      entry.indexes[digest] = manifest.manifests.map((m) => m.digest);
      for (const child of entry.indexes[digest]) {
        await describe(repo, child, await (await get(`/${repo}/manifests/${child}`)).json(), entry);
      }
    }
  };
  for (const repo of repositories) {
    const { tags } = await (await get(`/${repo}/tags/list?n=10000`)).json();
    const entry = { tags: {}, indexes: {} };
    for (const t of tags ?? []) {
      const r = await get(`/${repo}/manifests/${t}`);
      const digest = r.headers.get('docker-content-digest');
      if (!DIGEST.test(digest ?? '')) throw new Error(`no digest for ${repo}:${t}`);
      entry.tags[t] = digest;
      await describe(repo, digest, await r.json(), entry);
    }
    repos[repo] = entry;
  }
  return { repos, blobs };
}

function loadRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]+(-rehearsal)?\.json$/.test(f))
    .map((f) => {
      try {
        return { file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
      } catch {
        return { file: f }; // unreadable: nominates nothing
      }
    });
}

function printPlan(plan) {
  const short = (d) => d.slice(0, 19);
  console.log(
    `[prune] kept release commits (from signed provenance): ${plan.keptCommits.join(', ') || 'none'}`,
  );
  for (const k of plan.kept) console.log(`[prune] keep    ${k.repo}:${k.tag} ${short(k.digest)}`);
  for (const u of plan.untag) console.log(`[prune] untag   ${u.repo}:${u.tag} (${u.why})`);
  for (const m of plan.deleteManifests)
    console.log(`[prune] delete  ${m.repo}@${m.digest} — ${m.why}`);
  for (const u of plan.unowned)
    console.log(
      `[prune] unowned ${u.repo}:${u.tag} ${short(u.digest)} — no valid nomination; left alone`,
    );
  for (const o of plan.orphanedIndexes)
    console.log(
      `[prune] orphan  ${o.repo}:${o.tag} — signature index of an absent image; left alone`,
    );
  for (const i of plan.ignored) console.log(`[prune] ignored ${i.record}: ${i.why}`);
}

/** Waits until the registry answers on the host (compose reports healthy before Docker Desktop forwards the port). */
async function ready(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/v2/`)).ok) return base;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the registry at ${base} did not answer`);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function main(argv) {
  const {
    REPO,
    COMPOSE,
    DEFAULT_PUB,
    PREDICATES,
    VERIFY_FLAGS,
    RELEASE_NETWORK,
    RUN_LABEL,
    cosign,
    predicatesFrom,
    sh,
  } = await import('./release-lib.mjs');
  const { verifyRelease } = await import('./verify-release.mjs');
  const { acquireRegistryLock } = await import('./registry-lock.mjs');
  const apply = argv.includes('--apply');
  const pub = argv.includes('--pub') ? argv[argv.indexOf('--pub') + 1] : DEFAULT_PUB;
  const pins = argv
    .flatMap((a, i) => (a === '--keep' ? [argv[i + 1]] : []))
    .map((ref) => {
      const [repo, digest] = String(ref).split('@');
      if (!repo || !DIGEST.test(digest ?? ''))
        throw new Error(`--keep needs repo@sha256:…, got ${ref}`);
      return { repo, digest };
    });
  const releases = join(REPO, 'releases');
  pins.push(...deployPins(join(releases, 'deploy-state.json')));

  const compose = readFileSync(join(REPO, 'infra/compose/compose.dev.yml'), 'utf8');
  const registryImage = /image: (registry:3@sha256:[0-9a-f]{64})/.exec(compose)?.[1];
  if (!registryImage) throw new Error('the pinned registry image was not found in compose.dev.yml');
  const volume = 'univarse-dev_registry-data';
  const up = (allowFail = false) =>
    sh('docker', [...COMPOSE, '--profile', 'release', 'up', '-d', '--wait', 'registry'], {
      allowFail,
    });
  const stop = () => sh('docker', [...COMPOSE, '--profile', 'release', 'stop', 'registry']);
  const running = () =>
    sh('docker', [...COMPOSE, '--profile', 'release', 'ps', '--services', '--status', 'running'])
      .stdout.split(/\r?\n/)
      .includes('registry');

  /** Plan against a registry reachable at `base` (from the host) and `alias:5000` (from the offline tools). */
  async function planAt(base, alias) {
    const snapshot = await snapshotRegistry(base);
    const trust = {};
    const mounts = [[dirname(pub), '/trusted']];
    const key = `/trusted/${basename(pub)}`;
    for (const repo of Object.values(RELEASE_REPOS)) {
      for (const [t, d] of Object.entries(snapshot.repos[repo]?.tags ?? {})) {
        if (FALLBACK.test(t) || trust[`${repo}@${d}`]) continue;
        const ref = `${alias}:5000/${repo}@${d}`;
        const r = cosign(
          [
            'verify-attestation',
            '--key',
            key,
            '--type',
            PREDICATES.provenance,
            ...VERIFY_FLAGS,
            ref,
          ],
          { mounts, allowFail: true },
        );
        trust[`${repo}@${d}`] = classify(r, predicatesFrom);
      }
    }
    const records = loadRecords(releases);
    const plan = planPrune(snapshot, { records, trust, pins });
    return { snapshot, records, plan, verify: verificationTargets(trust, plan.keptCommits) };
  }

  // Both modes hold the lock: even a dry run may start and stop the registry.
  const lock = acquireRegistryLock(releases, apply ? 'prune --apply' : 'prune (dry run)');
  if (!apply) {
    const wasRunning = running();
    try {
      if (!wasRunning) up();
      const { plan, verify } = await planAt(await ready('http://127.0.0.1:5000'), 'registry');
      printPlan(plan);
      for (const t of verify.targets)
        console.log(
          `[prune] would verify ${t.file}: ${t.roles.map((role) => `${role} ${t.images[role].digest}`).join(', ')}`,
        );
      for (const p of verify.problems) console.log(`[prune] --apply would REFUSE: ${p}`);
      console.log(
        '[prune] dry run: nothing changed. --apply re-plans under the registry lock, then deletes.',
      );
    } finally {
      if (!wasRunning) stop();
      lock.release();
    }
    return;
  }

  const wasRunning = running();
  const name = `uv-prune-registry-${process.pid}`;
  const alias = `prune-registry-${process.pid}`;
  const startPrivate = async () => {
    const port = await freePort();
    // The same pinned image and hardening as compose's registry; a random loopback port and a private alias only.
    sh('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${RUN_LABEL}=prune-${process.pid}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--tmpfs',
      '/tmp:size=64m',
      '-e',
      'REGISTRY_STORAGE_DELETE_ENABLED=true',
      '-v',
      `${volume}:/var/lib/registry`,
      '-p',
      `127.0.0.1:${port}:5000`,
      registryImage,
    ]);
    sh('docker', ['network', 'connect', '--alias', alias, RELEASE_NETWORK, name]);
    return ready(`http://127.0.0.1:${port}`);
  };
  const stopPrivate = () => sh('docker', ['rm', '-f', name], { allowFail: true });
  try {
    if (!wasRunning) up(); // creates the release network the offline tools need
    stop(); // the public registry stays offline for the WHOLE apply
    let base = await startPrivate();
    const { snapshot: before, plan, verify } = await planAt(base, alias);
    printPlan(plan);
    // Every kept release is verified from trusted registry and provenance data, never from a record. If any kept
    // release can't be fully verified, stop here: nothing has been deleted.
    if (verify.problems.length) {
      throw new Error(
        `cannot verify every kept release; nothing deleted:\n  ${verify.problems.join('\n  ')}`,
      );
    }
    const verifyAll = (when) => {
      for (const r of verify.targets) {
        // As it was signed: its own role set (spec 0019; a release from before it holds api and web only).
        const v = verifyRelease(r, { pub, commit: r.commit, registry: `${alias}:5000`, roles: rolesOf(r.roles) });
        if (!v.ok)
          throw new Error(
            `${when}: kept release ${r.file} does not verify:\n  ${v.problems.join('\n  ')}`,
          );
        console.log(
          `[prune] ${when}: ${r.file} verified (signature, SBOM, provenance): ${r.roles.map((role) => `${role} ${r.images[role].digest}`).join(', ')}`,
        );
      }
      console.log(
        `[prune] ${when}: ${verify.targets.length} verification(s) covering all ${plan.keptCommits.length} kept release(s)`,
      );
    };
    verifyAll('before');

    const get = client(base);
    for (const u of plan.untag) await get(`/${u.repo}/manifests/${u.tag}`, { method: 'DELETE' });
    for (const m of plan.deleteManifests)
      await get(`/${m.repo}/manifests/${m.digest}`, { method: 'DELETE' });

    // Every kept manifest that existed before still exists; its blobs are what collection must not touch.
    const after = await snapshotRegistry(base);
    const keptBlobs = new Set();
    for (const [repo, live] of Object.entries(plan.live)) {
      for (const d of live) {
        const k = `${repo}@${d}`;
        if (!before.blobs[k]) continue; // a pin for a digest this registry never held
        if (!after.blobs[k]) throw new Error(`kept ${k} is no longer reachable after deletion`);
        for (const b of after.blobs[k]) keptBlobs.add(b);
      }
    }
    stopPrivate(); // collection needs the storage quiescent
    const gc = (extra) =>
      sh('docker', [
        'run',
        '--rm',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--network',
        'none',
        '-v',
        `${volume}:/var/lib/registry`,
        '--entrypoint',
        'registry',
        registryImage,
        'garbage-collect',
        ...extra,
        '/etc/distribution/config.yml',
      ]);
    const dry = gc(['--dry-run']).stdout;
    const eligible = [...dry.matchAll(/blob eligible for deletion: (sha256:[0-9a-f]{64})/g)].map(
      (m) => m[1],
    );
    // Fail closed: the per-blob lines must account for the summary's count, or the output wasn't understood.
    const summary =
      /(\d+) blobs marked, (\d+) blobs and (\d+) manifests eligible for deletion/.exec(dry);
    if (!summary || Number(summary[2]) !== eligible.length)
      throw new Error('garbage-collection dry run not understood; not run');
    const hit = eligible.filter((b) => keptBlobs.has(b));
    if (hit.length)
      throw new Error(`garbage collection would remove kept blobs (${hit.join(', ')}); not run`);
    console.log(
      `[prune] garbage collection: ${eligible.length} unreferenced blob(s), none kept; collecting (no --delete-untagged)`,
    );
    gc([]);
    base = await startPrivate();
    verifyAll('after');
    console.log(
      '[prune] done: every kept release, signature and attestation verified after collection.',
    );
  } finally {
    stopPrivate();
    if (wasRunning) up(true);
    lock.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[prune] ${e.message}`);
    process.exit(1);
  });
}
