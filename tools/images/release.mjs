// Spec 0013 local release (ADR-030, LR1–LR10): build once, gate that build, publish it to the local registry,
// sign and attest it with the owner's local key, verify it offline, and write a release record.
//   pnpm images:release              — from a clean `main`; signs with ~/.univarse/signing/cosign.key
//   pnpm images:release --rehearsal  — any clean branch; the record is marked rehearsal (the deploy refuses it)
//   options: --key <path to cosign.key>  --pub <path to cosign.pub>
// For producing a verified local deployment — NOT part of the everyday loop (pnpm dev, tests and PR CI are).
// The signing password is read once (hidden) or from COSIGN_PASSWORD, and reaches cosign only by environment.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { proveSecretCoverage } from './canary.mjs';
import { configOf, makeGates, samePushed, sameImage, TRIVY_CACHE } from './gates.mjs';
import { readFromTar } from './tar.mjs';
import {
  COMPOSE, COSIGN_IMAGE, cosign, DEFAULT_KEY, DEFAULT_PUB, HOST_REGISTRY, hostPath, IDENTITY, IDENTITY_ISSUER, PREDICATES, ROLES,
  registryConfigDigest, registryDigest, REPO, sh, SIGN_FLAGS, TOOL_REGISTRY, TRIVY_IMAGE,
} from './release-lib.mjs';
import { cleanupRun, ensureService as ensure, newRun, stopIfStarted as stopStarted } from './release-cleanup.mjs';
import { acquireRegistryLock } from './registry-lock.mjs';
import { verifyRelease } from './verify-release.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const rehearsal = flag('rehearsal');
const KEY = opt('key', DEFAULT_KEY);
const PUB = opt('pub', DEFAULT_PUB);
const WORK = join(tmpdir(), `univarse-release-${Date.now()}`);
// The images and Dockerfiles come from the trusted ROLES table (release-lib), the same one verification uses.
const IMAGES = Object.fromEntries(Object.entries(ROLES).map(([role, r]) => [role, r.dockerfile]));
// This run's ID: every container it starts is labelled with it, and cleanup removes only those (LR10). Children
// (smoke, journeys, run-container) read it from the environment for their labels and container names.
const RUN = newRun(`${Date.now().toString(36)}${randomBytes(3).toString('hex')}`);
process.env.UV_RELEASE_RUN = RUN.runId;
// schema 2: `refs` lists every registry tag this release pushed. Informational only: `pnpm images:prune` (LR8)
// never trusts a record to authorise a deletion.
const record = { schema: 2, rehearsal, startedAt: new Date().toISOString(), images: {}, gates: {}, negatives: {}, refs: [] };
/** The host's local `localhost:5000/…` tag copies; removed at cleanup (the registry keeps the pushed images). */
const hostTags = [];
function pushTag(local, repo, tag, opts) {
  const ref = `${HOST_REGISTRY}/${repo}:${tag}`;
  sh('docker', ['tag', local, ref]);
  hostTags.push(ref);
  record.refs.push({ repo, tag });
  sh('docker', ['push', ref], opts);
}
const step = (n) => console.log(`\n[release] ── ${n}`);
/** A gate result (gates.mjs) must pass; its output is printed either way. */
function must(r, what) {
  if (r.output?.trim()) console.log(r.output.trim());
  if (!r.ok) throw new Error(`${what} failed (exit ${r.status ?? 1})`);
  return r;
}

async function main() {
  // ── LR1: preconditions
  step('preconditions');
  if (sh('git', ['status', '--porcelain']).stdout.trim()) throw new Error('the working tree has uncommitted changes; a release builds a commit, not a work in progress');
  record.commit = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  record.branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (!rehearsal) {
    const onMain = sh('git', ['merge-base', '--is-ancestor', record.commit, 'origin/main'], { allowFail: true }).status === 0;
    if (!onMain) throw new Error(`commit ${record.commit.slice(0, 7)} is not on origin/main (use --rehearsal for a trial run on a branch)`);
  }
  for (const [p, what] of [[KEY, 'signing key'], [PUB, 'public key']]) if (!existsSync(p)) throw new Error(`${what} not found at ${p}`);
  const hostNet = sh('docker', ['run', '--rm', '--network', 'host', '--entrypoint', 'sh', TRIVY_IMAGE, '-c', 'nc -z -w 3 127.0.0.1 5432'], { allowFail: true });
  if (hostNet.status !== 0) throw new Error('Docker host networking is off (or Postgres is down). Docker Desktop: Settings → Resources → Network → Enable host networking, then Apply & restart.');
  const password = process.env.COSIGN_PASSWORD ?? (await askHidden(`Password for ${KEY}: `));
  mkdirSync(WORK, { recursive: true });
  console.log(`commit ${record.commit} (${record.branch})${rehearsal ? ' — REHEARSAL' : ''}; work dir ${WORK}`);

  // ── CS3: the base image's upstream signature (a read-only check of public data; our own signing stays offline)
  step('verify the base image upstream (CS3)');
  const base = /^ARG RUNTIME_IMAGE=(\S+)$/m.exec(readFileSync(join(REPO, IMAGES.api), 'utf8'))[1];
  if (/^ARG RUNTIME_IMAGE=(\S+)$/m.exec(readFileSync(join(REPO, IMAGES.web), 'utf8'))[1] !== base) throw new Error('api and web pin different runtime bases');
  cosign(['verify', base, '--certificate-identity', IDENTITY, '--certificate-oidc-issuer', IDENTITY_ISSUER], { offline: false });
  record.baseImage = { ref: base, upstreamSignature: 'verified' };
  console.log(`verified ${base}`);

  // ── LR1: build once
  step('build once (LR1)');
  const created = new Date().toISOString();
  for (const [name, file] of Object.entries(IMAGES)) {
    sh('docker', ['buildx', 'build', '--load', '--provenance=false', '--sbom=false', '-f', file, '-t', `univarse-${name}:release`,
      '--build-arg', `REVISION=${record.commit}`, '--build-arg', `CREATED=${created}`, '--build-arg', `VERSION=sha-${record.commit.slice(0, 7)}`, '.'], { stdio: 'inherit' });
    const tar = join(WORK, `${name}.tar`);
    sh('docker', ['save', `univarse-${name}:release`, '-o', tar]);
    const manifest = JSON.parse((await readFromTar(tar, 'manifest.json')).toString('utf8'));
    const configDigest = configOf(manifest);
    record.images[name] = { repo: ROLES[name].repo, dockerfile: file, configDigest, sizeBytes: Number(sh('docker', ['image', 'inspect', '-f', '{{.Size}}', `univarse-${name}:release`]).stdout.trim()) };
    console.log(`univarse-${name}:release config ${configDigest}`);
  }
  // Every later stage re-checks that the tag is still that image (CS6).
  const gates = makeGates({ work: WORK });
  const recheck = async () => {
    for (const name of Object.keys(record.images)) {
      const r = await sameImage(`univarse-${name}:release`, record.images[name].configDigest, WORK);
      if (!r.ok) throw new Error(r.output);
    }
  };

  // ── LR2: the same gates as CI, on that build
  step('inspection (CS1, CS2)');
  sh('node', ['--test', 'tools/images/rules.test.mjs']);
  for (const name of Object.keys(IMAGES)) must(gates.inspection(`univarse-${name}:release`), `inspection of univarse-${name}`);
  record.gates.inspection = 'pass';

  step('exceptions and policy (CS7)');
  sh('node', ['--test', 'tools/images/exceptions.test.mjs']);
  const exc = sh('node', ['tools/images/exceptions.mjs']);
  console.log(exc.stdout.trim());
  record.gates.exceptions = exc.stdout.includes('none active') ? 'none active' : 'ACTIVE — zero-findings can NOT be claimed';

  step('vulnerability, secret and misconfiguration gates, SBOM (CS7, CS8) — Trivy reads tarballs, never the Docker socket');
  // Fresh vulnerability data for every release; a broken download is retried across Trivy's official mirrors, and if
  // every attempt fails the release fails: it never scans without fresh data (CS9).
  const db0 = gates.freshDb();
  if (!db0.ok) throw new Error(`${db0.why}; nothing was scanned or published (CS9)`);
  const ver = sh('docker', ['run', '--rm', '-v', `${TRIVY_CACHE}:/root/.cache/trivy`, TRIVY_IMAGE, 'version', '--format', 'json']);
  const db = JSON.parse(ver.stdout).VulnerabilityDB ?? {};
  record.gates.trivy = { version: JSON.parse(ver.stdout).Version, dbUpdatedAt: db.UpdatedAt, dbDownloadedAt: db.DownloadedAt };
  for (const name of Object.keys(IMAGES)) {
    await recheck();
    const tar = `${name}.tar`;
    must(gates.vulnerabilityReport(tar, `trivy-${name}.json`), `vulnerability report for univarse-${name}`);
    const counts = sh('node', ['tools/images/trivy-summary.mjs', join(WORK, `trivy-${name}.json`), `univarse-${name}`]).stdout.trim();
    console.log(counts);
    record.gates[`vulnerabilities-${name}`] = counts;
    must(gates.vulnerability(tar), `vulnerability gate for univarse-${name}`);
    must(gates.secret(tar), `secret gate for univarse-${name}`);
    must(gates.misconfiguration(tar), `misconfiguration gate for univarse-${name}`);
    must(gates.sbom(tar, `sbom-${name}.spdx.json`), `SBOM for univarse-${name}`);
    record.images[name].sbomPackages = JSON.parse(readFileSync(join(WORK, `sbom-${name}.spdx.json`), 'utf8')).packages.length;
  }
  must(gates.dockerfiles('infra/docker'), 'Dockerfile misconfiguration gate');
  record.gates.vulnerability = record.gates.secret = record.gates.misconfiguration = 'pass';

  step('secret-gate coverage canaries (CS13): app file, a deployed @univarse package in node_modules, config env and label, history');
  await recheck();
  const canaries = await proveSecretCoverage('univarse-api:release', WORK);
  for (const [what, ok] of canaries.expected) console.log(`${ok ? 'found' : 'MISSED'}: ${what}`);
  if (!canaries.gateFailed) throw new Error('the secret gate did not fail on the canary image (CS13)');
  if (canaries.expected.some(([, ok]) => !ok)) throw new Error('a secret canary was not reported at its location: the secret gate does not cover what it promises (CS13)');
  record.gates.secretCanaries = { gateFailedOnCanaryImage: true, found: canaries.expected.map(([what]) => what) };

  step('hardened smoke run (CS4)');
  await recheck();
  sh('node', ['tools/images/smoke.mjs', '--api', 'univarse-api:release', '--web', 'univarse-web:release'], { stdio: 'inherit' });
  record.gates.smoke = 'pass';

  step('browser journeys against the containerised API, worker and web (CS5)');
  await ensureService('clamav');
  await recheck();
  sh('pnpm', ['--filter', '@univarse/web', 'test:e2e'], {
    stdio: 'inherit',
    env: { E2E_API_IMAGE: 'univarse-api:release', E2E_WEB_IMAGE: 'univarse-web:release', CI: '1' }, // CI=1: never reuse a running dev server
  });
  record.gates.journeys = 'pass';
  await stopIfStarted('clamav');

  // ── LR3/LR4: the local registry; push by digest without rebuilding
  step('publish to the local registry (LR3, LR4)');
  await ensureService('registry', ['--profile', 'release']);
  await recheck();
  const tag = `sha-${record.commit.slice(0, 7)}${rehearsal ? '-rehearsal' : ''}`;
  for (const [name, img] of Object.entries(record.images)) {
    pushTag(`univarse-${name}:release`, img.repo, tag, { stdio: 'inherit' });
    img.tag = tag;
    img.digest = await registryDigest(img.repo, tag);
    const same = samePushed(`${TOOL_REGISTRY}/${img.repo}@${img.digest}`, await registryConfigDigest(img.repo, img.digest), img.configDigest);
    if (!same.ok) throw new Error(same.output);
    console.log(same.output);
  }

  // ── LR5: sign and attest, offline, with the owner's key
  step('sign and attest offline (LR5) — tools on the internal network only');
  const keyMounts = [[dirname(KEY), '/key'], [WORK, '/work']];
  const keyIn = `/key/${basename(KEY)}`;
  for (const [name, img] of Object.entries(record.images)) {
    const ref = `${TOOL_REGISTRY}/${img.repo}@${img.digest}`;
    cosign(['sign', '--key', keyIn, ...SIGN_FLAGS, ref], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
    writeFileSync(join(WORK, `provenance-${name}.json`), JSON.stringify(provenance(name, img, base, created), null, 2));
    cosign(['attest', '--key', keyIn, '--type', PREDICATES.sbom, '--predicate', `/work/sbom-${name}.spdx.json`, ...SIGN_FLAGS, ref], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
    cosign(['attest', '--key', keyIn, '--type', PREDICATES.provenance, '--predicate', `/work/provenance-${name}.json`, ...SIGN_FLAGS, ref], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
    console.log(`signed and attested ${ref}`);
  }

  // ── LR6: verify against the committed public key, with negatives
  step('verify offline against the committed public key (LR6, LR9)');
  // The release may verify its own rehearsal; the deploy never accepts one (the flag is in the signed provenance).
  const v = verifyRelease(record, { pub: PUB, commit: record.commit, allowRehearsal: rehearsal });
  if (!v.ok) throw new Error(`verification failed:\n  ${v.problems.join('\n  ')}`);
  for (const ref of Object.values(v.results)) console.log(`verified ${ref}`);
  record.verification = { publicKeySha256: createHash('sha256').update(readFileSync(PUB)).digest('hex'), result: 'signature, SBOM and provenance verified offline' };

  // Negatives: a different key, an unsigned digest, and an edited record must all be rejected.
  const other = join(WORK, 'other-key');
  mkdirSync(other);
  sh('docker', ['run', '--rm', '--network', 'none', '-e', 'COSIGN_PASSWORD', '-v', `${hostPath(other)}:/k`, '-w', '/k', COSIGN_IMAGE, 'generate-key-pair'], { env: { COSIGN_PASSWORD: 'throwaway-negative-check' } });
  const wrongKey = verifyRelease(record, { pub: join(other, 'cosign.pub'), commit: record.commit, allowRehearsal: rehearsal });
  expectRejected(wrongKey, /api: signature does not verify/, 'a different public key (LR6)');
  // An unsigned image pushed into the TRUSTED api repository, so the only thing wrong is the missing signature.
  const unsignedTag = `unsigned-check-${tag}`;
  pushTag(COSIGN_IMAGE, ROLES.api.repo, unsignedTag);
  const unsigned = await registryDigest(ROLES.api.repo, unsignedTag);
  const edited = structuredClone(record);
  edited.images.api = { ...edited.images.api, digest: unsigned };
  const tampered = verifyRelease(edited, { pub: PUB, commit: record.commit, allowRehearsal: rehearsal });
  // A web image substituted for the API, fully signed. Signatures live per repository (cosign 3 stores them as
  // referrers; `cosign copy`/`load` can't move them into this HTTP registry), so the web image is pushed into the
  // trusted api repository and signed there with the same key, with its own SBOM and its GENUINE provenance
  // (role web, web Dockerfile). Every signed statement is true; only the role binding can reject it — the property
  // under test. This is the only extra signing a release does, and its tag says what it is.
  const swapTag = `role-swap-check-${tag}`;
  pushTag('univarse-web:release', ROLES.api.repo, swapTag);
  const swapDigest = await registryDigest(ROLES.api.repo, swapTag);
  const swapRef = `${TOOL_REGISTRY}/${ROLES.api.repo}@${swapDigest}`;
  cosign(['sign', '--key', keyIn, ...SIGN_FLAGS, swapRef], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
  cosign(['attest', '--key', keyIn, '--type', PREDICATES.sbom, '--predicate', '/work/sbom-web.spdx.json', ...SIGN_FLAGS, swapRef], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
  cosign(['attest', '--key', keyIn, '--type', PREDICATES.provenance, '--predicate', '/work/provenance-web.json', ...SIGN_FLAGS, swapRef], { mounts: keyMounts, env: { COSIGN_PASSWORD: password } });
  const swapped = structuredClone(record);
  swapped.images.api = { ...swapped.images.api, digest: swapDigest };
  const roleSwap = verifyRelease(swapped, { pub: PUB, commit: record.commit, allowRehearsal: rehearsal });
  // Deploy mode: a rehearsal is never deployable, whatever the record's JSON says.
  let deployRehearsal = null;
  if (rehearsal) {
    const asDeploy = structuredClone(record);
    asDeploy.rehearsal = false; // an edited flag changes nothing: the signed provenance says rehearsal
    deployRehearsal = verifyRelease(asDeploy, { pub: PUB, commit: record.commit });
    expectRejected(deployRehearsal, /rehearsal is never deployable/, 'a rehearsal in deploy mode (LR9)');
  }
  expectRejected(tampered, /api: signature does not verify.*no signatures found/, 'an edited record pointing at an unsigned digest (LR9)');
  expectRejected(roleSwap, /api: signed provenance does not name role api/, 'the signed web image in the api slot (LR9)');
  record.negatives = {
    differentKey: `rejected: ${wrongKey.problems[0]}`,
    editedRecordUnsignedDigest: `rejected: ${tampered.problems[0]}`,
    webImageInApiSlot: `rejected: ${roleSwap.problems[0]}`,
    ...(deployRehearsal ? { rehearsalInDeployMode: `rejected: ${deployRehearsal.problems[0]}` } : {}),
  };
  console.log(`rejected as required:\n  ${Object.values(record.negatives).join('\n  ')}`);
  // Offline proof: the signing tools could not reach the internet.
  const reach = sh('docker', ['run', '--rm', '--network', 'univarse-dev_release', '--entrypoint', 'sh', TRIVY_IMAGE, '-c', 'wget -qO- -T 5 https://rekor.sigstore.dev >/dev/null 2>&1 && echo reachable || echo blocked']);
  if (reach.stdout.trim() !== 'blocked') throw new Error('the release network can reach the internet; LR5 requires it to be internal');
  record.gates.offline = 'signing tools had no route to public Sigstore (internal network)';

  // ── LR7: the record (an index, not proof)
  record.finishedAt = new Date().toISOString();
  mkdirSync(join(REPO, 'releases'), { recursive: true });
  const out = join(REPO, 'releases', `${record.finishedAt.slice(0, 10)}-${record.commit.slice(0, 7)}${rehearsal ? '-rehearsal' : ''}.json`);
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  step(`done — record ${out}`);
  for (const [name, img] of Object.entries(record.images)) console.log(`${name}: ${TOOL_REGISTRY}/${img.repo}@${img.digest}`);
}

/** The config digest from a `docker save` manifest.json: `blobs/sha256/<hex>` (containerd store) or `<hex>.json` (classic). */
/** A negative must fail, and fail for its intended reason: a rejection for any other reason proves nothing. */
function expectRejected(result, reason, what) {
  if (result.ok) throw new Error(`${what} was ACCEPTED`);
  if (!result.problems.some((p) => reason.test(p))) throw new Error(`${what} was rejected for another reason, not the one under test: ${result.problems.join(' | ')}`);
}

function provenance(name, img, base, created) {
  return {
    buildDefinition: {
      buildType: 'https://univarse.local/release/v1',
      // role, dockerfile and rehearsal are signed here, so verification can bind them (LR9): the record can't.
      externalParameters: { role: name, rehearsal, commit: record.commit, branch: record.branch, dockerfile: ROLES[name].dockerfile, buildArgs: { REVISION: record.commit, CREATED: created, VERSION: `sha-${record.commit.slice(0, 7)}` } },
      resolvedDependencies: [{ uri: `oci://${base}`, digest: { sha256: base.split('@sha256:')[1] } }, { uri: 'git+local', digest: { gitCommit: record.commit } }],
    },
    runDetails: {
      builder: { id: 'local://univarse-release', version: { trivy: record.gates.trivy?.version, cosign: COSIGN_IMAGE } },
      metadata: { invocationId: `${record.commit.slice(0, 7)}-${name}-${Date.now()}`, startedOn: record.startedAt, finishedOn: new Date().toISOString() },
    },
  };
}

const cleanupDeps = { sh, compose: COMPOSE };
async function ensureService(name, profile = []) {
  ensure(RUN, name, { ...cleanupDeps, profile });
}
async function stopIfStarted(name) {
  stopStarted(RUN, name, cleanupDeps);
}
function cleanup() {
  try {
    cleanupRun(RUN, cleanupDeps); // only this run's services and labelled containers (LR10)
    // Untag only (the images stay under their other names); the registry keeps what was pushed.
    if (hostTags.length) sh('docker', ['image', 'rm', ...hostTags], { allowFail: true });
    rmSync(WORK, { recursive: true, force: true });
  } finally {
    lock?.release(); // last, after the registry this run may have started is stopped; even if cleanup fails
  }
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('no terminal for the signing password: run in a terminal, or set COSIGN_PASSWORD in your own shell'));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let pw = '';
    const onData = (b) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (ch === '\u0003') return reject(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
        else pw += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// One registry writer at a time (LR8): held for the whole release, so a prune or deploy never interleaves with it.
let lock;
try {
  lock = acquireRegistryLock(join(REPO, 'releases'), rehearsal ? 'release --rehearsal' : 'release');
  await main();
  cleanup();
} catch (e) {
  console.error(`\n[release] FAILED: ${e.message}`);
  cleanup();
  process.exit(1);
}
