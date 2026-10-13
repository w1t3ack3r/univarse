// Spec 0013 CS13 (re-scoped by ADR-030): every image gate fails for its intended reason.
//   pnpm images:proofs            (writes releases/proofs/<date>-<sha7>.json, git-ignored)
//
// Each proof builds ONE harmless mutant at run time (nothing vulnerable-looking is committed), runs it through the
// gate code the release runs (gates.mjs, inspect.mjs, exceptions.mjs), and requires:
//   • the gate fails;
//   • for its intended reason: the expected message, and no other violation;
//   • a clean control, identical but for the mutation, passes the same gate (so the gate isn't failing everything).
// Isolation: its own Trivy cache volume, a throwaway registry, image tags and containers labelled with this run's
// ID, all removed at the end. It never touches the local release registry or the release's Trivy cache.
//
// Proved elsewhere and cited by the record, not re-run here: the secret-gate canaries (every release, CS13), a
// different key / unsigned digest / role swap at verification (every release, LR6/LR9), and the workflow-policy
// fixtures (CS12, in CI).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeGates, samePushed, sameImage, savedConfig } from './gates.mjs';
import { REPO, RUN_LABEL, sh, TRIVY_IMAGE } from './release-lib.mjs';

const RUN = `proofs-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const WORK = mkdtempSync(join(tmpdir(), 'univarse-proofs-'));
const CACHE = `uv-trivy-proofs-${RUN}`;
const tag = (n) => `uv-proof-${n}:${RUN}`;
const builtTags = [];

const dockerfile = readFileSync(join(REPO, 'infra/docker/api.Dockerfile'), 'utf8');
const pin = (name) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1];
const RUNTIME_IMAGE = pin('RUNTIME_IMAGE');
const BUILD_IMAGE = pin('BUILD_IMAGE');
const FRONTEND = /^# syntax=(\S+)$/m.exec(dockerfile)?.[1];
const REGISTRY_IMAGE = /image: (registry:3@sha256:[0-9a-f]{64})/.exec(
  readFileSync(join(REPO, 'infra/compose/compose.dev.yml'), 'utf8'),
)?.[1];
if (!RUNTIME_IMAGE || !BUILD_IMAGE || !REGISTRY_IMAGE)
  throw new Error('could not read the pinned base, builder or registry image');

/** The clean control and its one-change mutants, as targets of one generated Dockerfile. */
const DOCKERFILE = `${FRONTEND ? `# syntax=${FRONTEND}\n` : ''}FROM ${BUILD_IMAGE} AS builder

FROM ${RUNTIME_IMAGE} AS good
LABEL org.opencontainers.image.source="https://github.com/w1t3ack3r/univarse" \\
      org.opencontainers.image.revision="cs13-proof" \\
      org.opencontainers.image.created="1970-01-01T00:00:00Z" \\
      org.opencontainers.image.version="cs13-proof"
USER 0:0
WORKDIR /app
COPY --chmod=0644 main.js /app/main.js
USER 65532:65532

FROM good AS root-user
USER 0:0

FROM good AS shell
USER 0:0
COPY --from=builder /bin/dash /bin/sh
USER 65532:65532

FROM good AS fixable
USER 0:0
COPY --chmod=0644 fixable.json /app/node_modules/lodash/package.json
USER 65532:65532

FROM good AS unfixed
USER 0:0
COPY --chmod=0644 unfixed.json /app/node_modules/ip/package.json
USER 65532:65532
`;

const proofs = [];
/** Record one proof: the mutant must fail for its reason, the control must pass. */
function prove(id, { gate, mutation, expected, mutant, control, onlyThis = () => true, note }) {
  const failedForReason = !mutant.ok && expected.test(mutant.output) && onlyThis(mutant.output);
  const entry = {
    id,
    gate,
    mutation,
    expected: String(expected),
    mutantFailed: !mutant.ok,
    failedForIntendedReason: failedForReason,
    controlPassed: control ? control.ok : null,
    excerpt: (
      mutant.output.split('\n').find((l) => expected.test(l)) ??
      mutant.output.trim().split('\n').at(-1) ??
      ''
    )
      .trim()
      .slice(0, 300),
    ...(note ? { note } : {}),
  };
  proofs.push(entry);
  const ok = failedForReason && (control ? control.ok : true);
  console.log(
    `[proofs] ${ok ? 'PROVED' : 'NOT PROVED'} ${id}: ${mutation} → ${gate}${ok ? '' : ` (failed: ${entry.mutantFailed}, reason: ${failedForReason}, control: ${entry.controlPassed})`}`,
  );
  if (!ok) console.log(mutant.output.trim().split('\n').slice(-15).join('\n'));
  return ok;
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

async function main() {
  const commit = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = sh('git', ['status', '--porcelain']).stdout.trim() !== '';
  const gates = makeGates({ work: WORK, cache: CACHE });

  // ── Fresh vulnerability data, as a release does (CS9): without it nothing is proved.
  const db = gates.freshDb();
  if (!db.ok) throw new Error(`${db.why}; no proof can be made`);

  // ── Build the control and the mutants (harmless: a one-line script and two bare package.json files).
  const ctx = join(WORK, 'ctx');
  mkdirSync(ctx);
  writeFileSync(join(ctx, 'Dockerfile'), DOCKERFILE);
  writeFileSync(join(ctx, 'main.js'), "console.log('cs13 proof control');\n");
  writeFileSync(join(ctx, 'fixable.json'), JSON.stringify({ name: 'lodash', version: '4.17.4' })); // CVE-2019-10744, CRITICAL, fixed in 4.17.12
  writeFileSync(join(ctx, 'unfixed.json'), JSON.stringify({ name: 'ip', version: '2.0.1' })); // CVE-2024-29415, HIGH, no fixed version
  for (const t of ['good', 'root-user', 'shell', 'fixable', 'unfixed']) {
    sh('docker', [
      'buildx',
      'build',
      '--load',
      '--provenance=false',
      '--sbom=false',
      '--target',
      t,
      '-t',
      tag(t),
      '--label',
      `${RUN_LABEL}=${RUN}`,
      ctx,
    ]);
    builtTags.push(tag(t));
    sh('docker', ['save', tag(t), '-o', join(WORK, `${t}.tar`)]);
  }
  // Every reported violation (inspect.mjs prints one FAIL line per kind) must be of the intended kind.
  const onlyInspectFails = (re) => (o) => {
    const fails = o.split('\n').filter((l) => l.includes('[inspect] FAIL '));
    return fails.length > 0 && fails.every((l) => re.test(l));
  };

  // ── CS1: inspection
  const goodInspect = gates.inspection(tag('good'));
  prove('CS1-root-user', {
    gate: 'inspection (inspect.mjs)',
    mutation: 'the image runs as root (USER 0:0)',
    expected: /user is "0:0", expected "65532:65532"/,
    mutant: gates.inspection(tag('root-user')),
    control: goodInspect,
    onlyThis: onlyInspectFails(/FAIL user is/),
  });
  prove('CS1-shell', {
    gate: 'inspection (inspect.mjs)',
    mutation:
      'the image contains a shell (dash copied to /bin/sh, which the base resolves to /usr/bin/sh)',
    // Both detections must fire independently: the file listing AND the attempt to run one.
    expected: /shell present: \/(usr\/)?bin\/sh/,
    mutant: gates.inspection(tag('shell')),
    control: goodInspect,
    onlyThis: (o) =>
      /running "sh" succeeded/.test(o) &&
      onlyInspectFails(/FAIL (shell present|running "sh" succeeded)/)(o),
  });

  // ── CS7: vulnerabilities — only the planted package may be reported, and it must be the named CVE.
  const findings = (name) => {
    gates.vulnerabilityReport(`${name}.tar`, `vuln-${name}.json`);
    const report = JSON.parse(readFileSync(join(WORK, `vuln-${name}.json`), 'utf8'));
    return (report.Results ?? [])
      .flatMap((r) => r.Vulnerabilities ?? [])
      .filter((v) => ['HIGH', 'CRITICAL'].includes(v.Severity));
  };
  const goodVuln = gates.vulnerability('good.tar');
  const fixable = findings('fixable');
  prove('CS7-fixable', {
    gate: 'vulnerability (Trivy, HIGH/CRITICAL, exit-code 1)',
    mutation: 'a known FIXABLE CRITICAL: lodash 4.17.4 (CVE-2019-10744, fixed in 4.17.12)',
    expected: /CVE-2019-10744/,
    mutant: gates.vulnerability('fixable.tar'),
    control: goodVuln,
    onlyThis: () =>
      fixable.length > 0 &&
      fixable.every((v) => v.PkgName === 'lodash') &&
      fixable.some((v) => v.VulnerabilityID === 'CVE-2019-10744' && v.FixedVersion),
  });
  const unfixed = findings('unfixed');
  prove('CS7-unfixed', {
    gate: 'vulnerability (Trivy, HIGH/CRITICAL, exit-code 1; no ignore-unfixed)',
    mutation: 'a known UNFIXED HIGH: ip 2.0.1 (CVE-2024-29415, no fixed version)',
    expected: /CVE-2024-29415/,
    mutant: gates.vulnerability('unfixed.tar'),
    control: goodVuln,
    onlyThis: () =>
      unfixed.length > 0 &&
      unfixed.every((v) => v.PkgName === 'ip') &&
      unfixed.some((v) => v.VulnerabilityID === 'CVE-2024-29415' && !v.FixedVersion),
  });

  // ── CS7: misconfiguration of a Dockerfile (the gate the release runs over infra/docker).
  const conf = (dir, text) => {
    mkdirSync(join(WORK, 'repo-proofs', dir), { recursive: true });
    writeFileSync(join(WORK, 'repo-proofs', dir, 'Dockerfile'), text);
  };
  conf('good', `FROM ${RUNTIME_IMAGE}\nUSER 65532:65532\nHEALTHCHECK NONE\n`);
  conf('root', `FROM ${RUNTIME_IMAGE}\nUSER root\nHEALTHCHECK NONE\n`);
  // The gate reads /repo-relative paths; the fixtures live under /work, so run it on /work paths.
  const confGate = (dir) => gates.dockerfiles(`/work/repo-proofs/${dir}`);
  prove('CS7-misconfiguration', {
    gate: 'Dockerfile misconfiguration (trivy config, HIGH/CRITICAL)',
    mutation: 'the Dockerfile’s last USER is root',
    expected: /DS-?0*02|root/i,
    mutant: confGate('root'),
    control: confGate('good'),
    onlyThis: (o) => /HIGH: 1|Failures: 1|DS002|DS-0002/.test(o),
  });

  // ── CS7: exceptions and the ignore-unfixed policy, through the exceptions check (exceptions.mjs --root).
  const tree = (name, { ignore, workflow = 'name: ci\non: pull_request\n' }) => {
    const root = join(WORK, `exc-${name}`);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'tools/images'), { recursive: true });
    writeFileSync(join(root, '.trivyignore.yaml'), ignore);
    writeFileSync(join(root, '.github/workflows/ci.yml'), workflow);
    writeFileSync(join(root, 'tools/images/trivy-secret.yaml'), 'rules: []\n');
    return root;
  };
  const excRun = (root) => {
    const r = sh('node', ['tools/images/exceptions.mjs', '--root', root, '--today', '2026-10-13'], {
      allowFail: true,
    });
    return { ok: r.status === 0, status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const entry = (over) =>
    `vulnerabilities:\n  - id: CVE-2024-29415\n    purls:\n      - pkg:npm/ip@2.0.1\n${over}secrets: []\nmisconfigurations: []\n`;
  const excControl = excRun(
    tree('good', {
      ignore: entry('    statement: proof fixture\n    owner: owner\n    expired_at: 2026-10-20\n'),
    }),
  );
  prove('CS7-exception-expired', {
    gate: 'exceptions (exceptions.mjs)',
    mutation: 'an exception past its expiry',
    expected: /expired on 2026-10-01/,
    mutant: excRun(
      tree('expired', {
        ignore: entry(
          '    statement: proof fixture\n    owner: owner\n    expired_at: 2026-10-01\n',
        ),
      }),
    ),
    control: excControl,
    onlyThis: (o) => (o.match(/\[exceptions\] FAIL/g) ?? []).length === 1,
  });
  prove('CS7-exception-incomplete', {
    gate: 'exceptions (exceptions.mjs)',
    mutation: 'an exception missing its evidence and owner',
    expected: /missing statement[\s\S]*missing owner|missing owner[\s\S]*missing statement/,
    mutant: excRun(tree('incomplete', { ignore: entry('    expired_at: 2026-10-20\n') })),
    control: excControl,
    onlyThis: (o) => (o.match(/\[exceptions\] FAIL/g) ?? []).length === 2,
  });
  prove('CS7-ignore-unfixed', {
    gate: 'exceptions and policy (exceptions.mjs)',
    mutation: '`ignore-unfixed` added to a workflow',
    expected: /uses ignore-unfixed/,
    mutant: excRun(
      tree('ignore-unfixed', {
        ignore: 'vulnerabilities: []\nsecrets: []\nmisconfigurations: []\n',
        workflow:
          'name: ci\non: pull_request\njobs:\n  s:\n    steps:\n      - run: trivy image --ignore-unfixed x\n',
      }),
    ),
    control: excRun(
      tree('clean', { ignore: 'vulnerabilities: []\nsecrets: []\nmisconfigurations: []\n' }),
    ),
    onlyThis: (o) => (o.match(/\[exceptions\] FAIL/g) ?? []).length === 1,
  });

  // ── CS9: the vulnerability DB unreachable — the download fails closed, so nothing is scanned.
  const offline = makeGates({ work: WORK, cache: `${CACHE}-offline`, network: 'none' }).freshDb({
    attempts: 2,
  });
  prove('CS9-db-unreachable', {
    gate: 'fresh vulnerability DB (gates.freshDb; the release throws and scans nothing)',
    mutation: 'no network to any DB mirror',
    expected: /(failed|error|unable|no such host|dial)/i,
    mutant: offline,
    control: db,
    note: `${offline.attempts} attempts, all failed; release.mjs stops with "could not download a fresh vulnerability database" before any scan`,
  });

  // ── CS6: an image substituted after gating — caught before scanning goes on, and again at push.
  const gatedTag = tag('gated');
  sh('docker', ['tag', tag('good'), gatedTag]);
  builtTags.push(gatedTag);
  const gatedConfig = await savedConfig(gatedTag, WORK, 'gated.tar');
  const stillSame = await sameImage(gatedTag, gatedConfig, WORK);
  sh('docker', ['tag', tag('root-user'), gatedTag]); // the substitution
  prove('CS6-substituted-before-push', {
    gate: 'artifact consistency (gates.sameImage, re-checked before every later stage)',
    mutation: 'the gated tag re-pointed at another image after gating',
    expected: /changed since it was gated/,
    mutant: await sameImage(gatedTag, gatedConfig, WORK),
    control: stillSame,
  });

  // At push: a throwaway registry (tmpfs, loopback, removed at the end), never the release registry.
  const port = await freePort();
  const regName = `uv-proof-registry-${RUN}`;
  sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    regName,
    '--label',
    `${RUN_LABEL}=${RUN}`,
    '--read-only',
    '--tmpfs',
    '/var/lib/registry',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '-p',
    `127.0.0.1:${port}:5000`,
    REGISTRY_IMAGE,
  ]);
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/v2/`)).ok) break;
      } catch {
        // starting
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const pushed = async (local) => {
      const ref = `127.0.0.1:${port}/proof:${RUN}`;
      sh('docker', ['tag', local, ref]);
      builtTags.push(ref);
      sh('docker', ['push', ref]);
      const accept =
        'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
      const m = await (
        await fetch(`${base}/v2/proof/manifests/${RUN}`, { headers: { accept } })
      ).json();
      return m.config.digest;
    };
    const controlPush = samePushed(
      'proof (gated image pushed)',
      await pushed(tag('good')),
      gatedConfig,
    );
    prove('CS6-substituted-at-push', {
      gate: 'artifact consistency at push (gates.samePushed: registry config vs gated config)',
      mutation: 'a different image pushed under the release tag',
      expected: /not the gated sha256:/,
      mutant: samePushed(
        'proof (substituted image pushed)',
        await pushed(tag('root-user')),
        gatedConfig,
      ),
      control: controlPush,
    });
  } finally {
    sh('docker', ['rm', '-f', regName], { allowFail: true });
  }

  // ── The record.
  const ver = JSON.parse(
    sh('docker', [
      'run',
      '--rm',
      '-v',
      `${CACHE}:/root/.cache/trivy`,
      TRIVY_IMAGE,
      'version',
      '--format',
      'json',
    ]).stdout,
  );
  const all = proofs.every((p) => p.failedForIntendedReason && p.controlPassed !== false);
  const record = {
    schema: 1,
    spec: '0013 CS13',
    at: new Date().toISOString(),
    commit,
    dirtyTree: dirty,
    trivy: {
      version: ver.Version,
      dbUpdatedAt: ver.VulnerabilityDB?.UpdatedAt,
      dbDownloadedAt: ver.VulnerabilityDB?.DownloadedAt,
    },
    base: RUNTIME_IMAGE,
    proofs,
    provedElsewhere: {
      secretCanaries:
        'every release (release.mjs, canary.mjs): the secret gate fails on the canary image and finds all five canaries; LR10 record releases/2026-10-12-12083b8.json',
      verification:
        'every release (LR6/LR9): different key, unsigned digest and role swap each rejected for its intended reason; LR10 record',
      workflowPolicy: 'CS12 fixtures, in CI (tools/ci-policy)',
    },
    allProved: all,
  };
  const out = join(
    REPO,
    'releases',
    'proofs',
    `${record.at.slice(0, 19).replace(/[:T]/g, '-')}-${commit.slice(0, 7)}${dirty ? '-dirty' : ''}.json`, // never overwrites an earlier run,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `[proofs] ${proofs.filter((p) => p.failedForIntendedReason && p.controlPassed !== false).length}/${proofs.length} proved; record ${out}`,
  );
  if (!all) throw new Error('not every gate failed for its intended reason');
}

try {
  await main();
} catch (e) {
  console.error(`[proofs] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (builtTags.length) sh('docker', ['image', 'rm', '-f', ...builtTags], { allowFail: true });
  const left = sh('docker', ['ps', '-aq', '--filter', `label=${RUN_LABEL}=${RUN}`], {
    allowFail: true,
  })
    .stdout.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (left.length) sh('docker', ['rm', '-f', ...left], { allowFail: true });
  sh('docker', ['volume', 'rm', '-f', CACHE, `${CACHE}-offline`], { allowFail: true });
  rmSync(WORK, { recursive: true, force: true });
}
