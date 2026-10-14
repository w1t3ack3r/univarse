// Spec 0013 CS13 / LR10: prove the secret gate's coverage with harmless canaries.
//   node tools/images/canary.mjs <gated image> <work dir>
// Builds a throwaway image FROM the gated API image, plants secret-shaped values (generated at run time, never
// committed, never valid credentials) in every place the secret gate promises to cover, scans it with exactly
// the gate's Trivy configuration, and fails unless:
//   • the gate itself fails (exit code 1), and
//   • every canary is reported at its location: an app file under /app; a file inside the real directory of a
//     deployed workspace package (node_modules/.pnpm/@univarse+db@…/node_modules/@univarse/db/dist, Trivy's
//     default node_modules skip disabled); an environment variable and a label (image configuration); and a
//     build step (image history).
// Each location uses a different rule (GitHub token, AWS key, Stripe key), so a finding can be attributed.
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGates } from './gates.mjs';
import { REPO, sh } from './release-lib.mjs';
import { consumeDockerExport } from './tar.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const pick = (set, n) => Array.from({ length: n }, () => set[randomInt(set.length)]).join('');
// Built here, at run time: no secret-shaped literal exists in the repository (gitleaks; CLAUDE.md invariant 8).
const githubToken = () => ['gh', 'p_'].join('') + pick(ALNUM, 36);
const awsKeyId = () => ['AK', 'IA'].join('') + pick(UPPER, 16);
const stripeKey = () => ['sk', '_live_'].join('') + pick(ALNUM, 32);

/** The real (non-symlink) dist directory of the deployed @univarse/db package inside the image. */
async function realPackageDir(image) {
  const id = sh('docker', ['create', image]).stdout.trim();
  try {
    let found = null;
    // A malformed or truncated export rejects (consumeTar): it never reads as "nothing found".
    await consumeDockerExport(
      id,
      (e) => {
        if (!found && e.type === 'dir' && /node_modules\/\.pnpm\/@univarse\+db@[^/]+\/node_modules\/@univarse\/db\/dist\/?$/.test(e.path)) found = e.path.replace(/\/$/, '');
      },
      {},
      { spawn },
    );
    if (!found) throw new Error(`no deployed @univarse/db directory found in ${image}`);
    return found;
  } finally {
    sh('docker', ['rm', id], { allowFail: true });
  }
}

export async function proveSecretCoverage(image, work) {
  const dir = join(work, 'canary');
  mkdirSync(dir, { recursive: true });
  const pkgDir = await realPackageDir(image);
  const c = { appFile: githubToken(), packageFile: githubToken(), env: awsKeyId(), label: stripeKey(), history: githubToken() };
  writeFileSync(join(dir, 'canary-app.js'), `// harmless canary, generated for this run\nexport const token = '${c.appFile}';\n`);
  writeFileSync(join(dir, 'canary-pkg.js'), `// harmless canary, generated for this run\nexport const token = '${c.packageFile}';\n`);
  writeFileSync(join(dir, 'Dockerfile'), [
    `FROM ${image}`,
    'COPY canary-app.js /app/canary-app.js',
    `COPY canary-pkg.js /${pkgDir}/canary-pkg.js`,
    `ENV UV_CANARY_ENV=${c.env}`,
    `LABEL uv.canary=${c.label}`,
    // History: the distroless image has no shell, but it has node; the command text is recorded in the history.
    `RUN ["/nodejs/bin/node", "-e", "// ${c.history}"]`,
    '',
  ].join('\n'));
  sh('docker', ['build', '-q', '-t', 'univarse-canary:check', dir]);
  sh('docker', ['save', 'univarse-canary:check', '-o', join(dir, 'canary.tar')]);

  // 1. The secret gate, the very code the release runs (gates.mjs), must fail.
  const gates = makeGates({ work: dir });
  const gate = gates.secret('canary.tar');
  // 2. Every canary must be found at its location.
  gates.secretReport('canary.tar', 'canary.json');
  const report = JSON.parse(readFileSync(join(dir, 'canary.json'), 'utf8'));
  // File findings carry the file's path (leading "/"); image configuration and history findings are reported
  // against the scanned input itself (/work/canary.tar). An ENV or LABEL instruction is also recorded in the
  // history, so those two canaries appear twice; the RUN-step canary exists only in the history.
  const findings = (report.Results ?? []).flatMap((r) => (r.Secrets ?? []).map((s) => ({ target: r.Target.replace(/^\//, ''), rule: s.RuleID })));
  const config = findings.filter((f) => f.target === 'work/canary.tar');
  const expected = [
    ['app file /app/canary-app.js', findings.some((f) => f.target === 'app/canary-app.js' && f.rule === 'github-pat')],
    [`workspace package file /${pkgDir}/canary-pkg.js`, findings.some((f) => f.target === `${pkgDir}/canary-pkg.js` && f.rule === 'github-pat')],
    ['image configuration: environment variable (AWS key)', config.some((f) => f.rule === 'aws-access-key-id')],
    ['image configuration: label (Stripe key)', config.some((f) => f.rule === 'stripe-secret-token')],
    ['image history: RUN build step (GitHub token; present only in the history)', config.some((f) => f.rule === 'github-pat')],
  ];
  sh('docker', ['rmi', '-f', 'univarse-canary:check'], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
  return { gateFailed: gate.status === 1, expected, findings };
}

if (process.argv[1]?.endsWith('canary.mjs')) {
  const [image, work] = process.argv.slice(2);
  const r = await proveSecretCoverage(image ?? 'univarse-api:release', work ?? join(REPO, '.canary-work'));
  console.log(`[canary] gate failed on the canary image: ${r.gateFailed ? 'yes' : 'NO'}`);
  for (const [what, ok] of r.expected) console.log(`[canary] ${ok ? 'found' : 'MISSED'}: ${what}`);
  if (!r.gateFailed || r.expected.some(([, ok]) => !ok)) {
    console.log(`[canary] all findings: ${JSON.stringify(r.findings)}`);
    process.exit(1);
  }
}
