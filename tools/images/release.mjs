// Spec 0013 local release (ADR-030, LR1–LR10): build once, gate that build, publish it to the local registry,
// sign and attest it with the owner's local key, verify it offline, and write a release record.
//   pnpm images:release              — from a clean `main`; signs with ~/.univarse/signing/cosign.key
//   pnpm images:release --rehearsal  — any clean branch; the record is marked rehearsal (the deploy refuses it)
//   options: --key <path to cosign.key>  --pub <path to cosign.pub>
// For producing a verified local deployment — NOT part of the everyday loop (pnpm dev, tests and PR CI are).
// The signing password is read once (hidden) or from COSIGN_PASSWORD, and reaches cosign only by environment.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { proveSecretCoverage } from './canary.mjs';
import { readFromTar } from './tar.mjs';
import {
  COMPOSE, COSIGN_IMAGE, cosign, DEFAULT_KEY, DEFAULT_PUB, HOST_REGISTRY, hostPath, IDENTITY, IDENTITY_ISSUER, PREDICATES,
  registryConfigDigest, registryDigest, REPO, sh, SIGN_FLAGS, TOOL_REGISTRY, TRIVY_IMAGE,
} from './release-lib.mjs';
import { verifyRelease } from './verify-release.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const rehearsal = flag('rehearsal');
const KEY = opt('key', DEFAULT_KEY);
const PUB = opt('pub', DEFAULT_PUB);
const WORK = join(tmpdir(), `univarse-release-${Date.now()}`);
const IMAGES = { api: 'infra/docker/api.Dockerfile', web: 'infra/docker/web.Dockerfile' };
const started = []; // services this release started, and only these, are stopped at the end (LR10)
const record = { schema: 1, rehearsal, startedAt: new Date().toISOString(), images: {}, gates: {}, negatives: {} };
const step = (n) => console.log(`\n[release] ── ${n}`);

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
    record.images[name] = { repo: `univarse-${name}`, dockerfile: file, configDigest, sizeBytes: Number(sh('docker', ['image', 'inspect', '-f', '{{.Size}}', `univarse-${name}:release`]).stdout.trim()) };
    console.log(`univarse-${name}:release config ${configDigest}`);
  }
  // Every later stage re-checks that the tag is still that image (CS6).
  const recheck = async () => {
    for (const [name, img] of Object.entries(record.images)) {
      const tar = join(WORK, `${name}-recheck.tar`);
      sh('docker', ['save', `univarse-${name}:release`, '-o', tar]);
      const m = JSON.parse((await readFromTar(tar, 'manifest.json')).toString('utf8'));
      rmSync(tar);
      if (configOf(m) !== img.configDigest) throw new Error(`univarse-${name}:release changed since it was built (CS6)`);
    }
  };

  // ── LR2: the same gates as CI, on that build
  step('inspection (CS1, CS2)');
  sh('node', ['--test', 'tools/images/rules.test.mjs']);
  for (const name of Object.keys(IMAGES)) sh('node', ['tools/images/inspect.mjs', `univarse-${name}:release`, '--root', 'app'], { stdio: 'inherit' });
  record.gates.inspection = 'pass';

  step('exceptions and policy (CS7)');
  sh('node', ['--test', 'tools/images/exceptions.test.mjs']);
  const exc = sh('node', ['tools/images/exceptions.mjs']);
  console.log(exc.stdout.trim());
  record.gates.exceptions = exc.stdout.includes('none active') ? 'none active' : 'ACTIVE — zero-findings can NOT be claimed';

  step('vulnerability, secret and misconfiguration gates, SBOM (CS7, CS8) — Trivy reads tarballs, never the Docker socket');
  const trivyRun = (args, opts = {}) =>
    sh('docker', ['run', '--rm', '-v', 'uv-trivy-cache:/root/.cache/trivy', '-v', `${hostPath(WORK)}:/work`, '-v', `${hostPath(REPO)}:/repo:ro`, '-w', '/repo', TRIVY_IMAGE, ...args], { stdio: 'inherit', ...opts });
  // --no-progress exists only on `trivy image` (`trivy config` rejects it).
  const trivy = (args) => trivyRun(args[0] === 'image' ? [args[0], '--no-progress', ...args.slice(1)] : args);
  trivy(['clean', '--vuln-db']); // fresh vulnerability data for every release (LR10)
  // A broken download is retried (Trivy's official mirrors, in order); if every attempt fails, the release fails:
  // it never scans without fresh data (CS9).
  const DB_REPOS = 'mirror.gcr.io/aquasec/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2,public.ecr.aws/aquasecurity/trivy-db:2';
  let fetched = false;
  for (let attempt = 1; attempt <= 3 && !fetched; attempt++) {
    const r = trivyRun(['image', '--no-progress', '--download-db-only', '--db-repository', DB_REPOS], { allowFail: true });
    fetched = r.status === 0;
    if (!fetched) console.log(`[release] vulnerability DB download failed (attempt ${attempt} of 3)`);
  }
  if (!fetched) throw new Error('could not download a fresh vulnerability database after 3 attempts; nothing was scanned or published (CS9)');
  const ver = sh('docker', ['run', '--rm', '-v', 'uv-trivy-cache:/root/.cache/trivy', TRIVY_IMAGE, 'version', '--format', 'json']);
  const db = JSON.parse(ver.stdout).VulnerabilityDB ?? {};
  record.gates.trivy = { version: JSON.parse(ver.stdout).Version, dbUpdatedAt: db.UpdatedAt, dbDownloadedAt: db.DownloadedAt };
  for (const name of Object.keys(IMAGES)) {
    await recheck();
    const input = ['--input', `/work/${name}.tar`];
    trivy(['image', ...input, '--skip-db-update', '--scanners', 'vuln', '--format', 'json', '--output', `/work/trivy-${name}.json`]);
    const counts = sh('node', ['tools/images/trivy-summary.mjs', join(WORK, `trivy-${name}.json`), `univarse-${name}`]).stdout.trim();
    console.log(counts);
    record.gates[`vulnerabilities-${name}`] = counts;
    trivy(['image', ...input, '--skip-db-update', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--ignorefile', '.trivyignore.yaml', '--exit-code', '1']);
    trivy(['image', ...input, '--skip-db-update', '--scanners', 'secret', '--secret-config', 'tools/images/trivy-secret.yaml', '--image-config-scanners', 'secret', '--ignorefile', '.trivyignore.yaml', '--exit-code', '1']);
    trivy(['image', ...input, '--skip-db-update', '--scanners', 'misconfig', '--image-config-scanners', 'misconfig', '--severity', 'HIGH,CRITICAL', '--ignorefile', '.trivyignore.yaml', '--exit-code', '1']);
    trivy(['image', ...input, '--skip-db-update', '--format', 'spdx-json', '--output', `/work/sbom-${name}.spdx.json`]);
    record.images[name].sbomPackages = JSON.parse(readFileSync(join(WORK, `sbom-${name}.spdx.json`), 'utf8')).packages.length;
  }
  trivy(['config', '--severity', 'HIGH,CRITICAL', '--ignorefile', '.trivyignore.yaml', '--exit-code', '1', 'infra/docker']);
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
    sh('docker', ['tag', `univarse-${name}:release`, `${HOST_REGISTRY}/${img.repo}:${tag}`]);
    sh('docker', ['push', `${HOST_REGISTRY}/${img.repo}:${tag}`], { stdio: 'inherit' });
    img.tag = tag;
    img.digest = await registryDigest(img.repo, tag);
    const pushedConfig = await registryConfigDigest(img.repo, img.digest);
    if (pushedConfig !== img.configDigest) throw new Error(`pushed ${img.repo}@${img.digest} has config ${pushedConfig}, not the gated ${img.configDigest} (CS6)`);
    console.log(`${TOOL_REGISTRY}/${img.repo}@${img.digest} = the gated image (config ${pushedConfig})`);
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
  const v = verifyRelease(record, { pub: PUB, commit: record.commit });
  if (!v.ok) throw new Error(`verification failed:\n  ${v.problems.join('\n  ')}`);
  for (const ref of Object.values(v.results)) console.log(`verified ${ref}`);
  record.verification = { publicKeySha256: createHash('sha256').update(readFileSync(PUB)).digest('hex'), result: 'signature, SBOM and provenance verified offline' };

  // Negatives: a different key, an unsigned digest, and an edited record must all be rejected.
  const other = join(WORK, 'other-key');
  mkdirSync(other);
  sh('docker', ['run', '--rm', '--network', 'none', '-e', 'COSIGN_PASSWORD', '-v', `${hostPath(other)}:/k`, '-w', '/k', COSIGN_IMAGE, 'generate-key-pair'], { env: { COSIGN_PASSWORD: 'throwaway-negative-check' } });
  const wrongKey = verifyRelease(record, { pub: join(other, 'cosign.pub'), commit: record.commit });
  if (wrongKey.ok) throw new Error('a different public key verified the release (LR6 negative failed)');
  sh('docker', ['tag', COSIGN_IMAGE, `${HOST_REGISTRY}/univarse-unsigned-check:${tag}`]);
  sh('docker', ['push', `${HOST_REGISTRY}/univarse-unsigned-check:${tag}`]);
  const unsigned = await registryDigest('univarse-unsigned-check', tag);
  const edited = structuredClone(record);
  edited.images.api = { ...edited.images.api, repo: 'univarse-unsigned-check', digest: unsigned };
  const tampered = verifyRelease(edited, { pub: PUB, commit: record.commit });
  if (tampered.ok) throw new Error('an edited record pointing at an unsigned digest was accepted (LR9 negative failed)');
  record.negatives = {
    differentKey: `rejected: ${wrongKey.problems[0]}`,
    editedRecordUnsignedDigest: `rejected: ${tampered.problems[0]}`,
  };
  console.log(`rejected as required:\n  ${record.negatives.differentKey}\n  ${record.negatives.editedRecordUnsignedDigest}`);
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
function configOf(manifest) {
  const hex = /([0-9a-f]{64})(?:\.json)?$/.exec(manifest[0].Config)?.[1];
  if (!hex) throw new Error(`can't read the config digest from manifest.json (${manifest[0].Config})`);
  return `sha256:${hex}`;
}

function provenance(name, img, base, created) {
  return {
    buildDefinition: {
      buildType: 'https://univarse.local/release/v1',
      externalParameters: { commit: record.commit, branch: record.branch, dockerfile: img.dockerfile, buildArgs: { REVISION: record.commit, CREATED: created, VERSION: `sha-${record.commit.slice(0, 7)}` } },
      resolvedDependencies: [{ uri: `oci://${base}`, digest: { sha256: base.split('@sha256:')[1] } }, { uri: 'git+local', digest: { gitCommit: record.commit } }],
    },
    runDetails: {
      builder: { id: 'local://univarse-release', version: { trivy: record.gates.trivy?.version, cosign: COSIGN_IMAGE } },
      metadata: { invocationId: `${record.commit.slice(0, 7)}-${name}-${Date.now()}`, startedOn: record.startedAt, finishedOn: new Date().toISOString() },
    },
  };
}

async function ensureService(name, profile = []) {
  const running = sh('docker', [...COMPOSE, ...profile, 'ps', '--status', 'running', '--services'], { allowFail: true }).stdout.split('\n').includes(name);
  if (running) return;
  sh('docker', [...COMPOSE, ...profile, 'up', '-d', '--wait', name], { stdio: 'inherit' });
  started.push({ name, profile });
}
async function stopIfStarted(name) {
  const i = started.findIndex((s) => s.name === name);
  if (i < 0) return;
  const [s] = started.splice(i, 1);
  sh('docker', [...COMPOSE, ...s.profile, 'stop', name], { allowFail: true });
}
function cleanup() {
  for (const s of [...started].reverse()) sh('docker', [...COMPOSE, ...s.profile, 'stop', s.name], { allowFail: true });
  sh('docker', ['rm', '-f', 'uv-smoke-api', 'uv-smoke-web', 'uv-smoke-worker', 'uv-e2e-api', 'uv-e2e-web', 'uv-e2e-worker'], { allowFail: true });
  rmSync(WORK, { recursive: true, force: true });
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

try {
  await main();
  cleanup();
} catch (e) {
  console.error(`\n[release] FAILED: ${e.message}`);
  cleanup();
  process.exit(1);
}
