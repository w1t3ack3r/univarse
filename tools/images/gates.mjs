// Spec 0013 CS1/CS6/CS7/CS9: the image gates, as one module used by BOTH the release (release.mjs) and the CS13
// gate proofs (gate-proofs.mjs), so a proof exercises exactly the code a release runs. A gate never throws on a
// finding: it returns { ok, status, output } and the caller decides. Output is captured (and the release prints
// it), so a proof can check that a gate failed for its intended reason.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostPath, REPO, sh as realSh, TRIVY_IMAGE } from './release-lib.mjs';
import { readFromTar } from './tar.mjs';

export const DB_REPOS =
  'mirror.gcr.io/aquasec/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2,public.ecr.aws/aquasecurity/trivy-db:2';
export const TRIVY_CACHE = 'uv-trivy-cache';

const result = (r) => ({
  ok: r.status === 0,
  status: r.status,
  output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
});

/** The config digest Docker recorded for the first image in a `docker save` manifest.json. */
export function configOf(manifest) {
  const hex = /([0-9a-f]{64})(?:\.json)?$/.exec(manifest[0].Config)?.[1];
  if (!hex)
    throw new Error(`can't read the config digest from manifest.json (${manifest[0].Config})`);
  return `sha256:${hex}`;
}

/**
 * The gates. `work` is a directory Trivy sees as /work; `cache` the Trivy DB volume; `network` (optional) the Docker
 * network for Trivy (CS9 proofs use an unreachable one).
 */
export function makeGates({ work, sh = realSh, cache = TRIVY_CACHE, network } = {}) {
  const trivyRun = (args) =>
    sh(
      'docker',
      [
        'run',
        '--rm',
        ...(network ? ['--network', network] : []),
        '-v',
        `${cache}:/root/.cache/trivy`,
        '-v',
        `${hostPath(work)}:/work`,
        '-v',
        `${hostPath(REPO)}:/repo:ro`,
        '-w',
        '/repo',
        TRIVY_IMAGE,
        ...args,
      ],
      { allowFail: true },
    );
  // --no-progress exists only on `trivy image` (`trivy config` rejects it).
  const trivy = (args) =>
    result(trivyRun(args[0] === 'image' ? [args[0], '--no-progress', ...args.slice(1)] : args));
  const tarInput = (tar) => ['--input', `/work/${tar}`];
  const SECRET = (tar) => [
    'image',
    ...tarInput(tar),
    '--skip-db-update',
    '--scanners',
    'secret',
    '--secret-config',
    'tools/images/trivy-secret.yaml',
    '--image-config-scanners',
    'secret',
    '--ignorefile',
    '.trivyignore.yaml',
  ];

  return {
    trivyRun,
    /** CS1/CS2: user, labels, no shell, no UniVarse source/test/env files, root-owned app tree. */
    inspection: (image, root = 'app') =>
      result(sh('node', ['tools/images/inspect.mjs', image, '--root', root], { allowFail: true })),
    /** CS7/CS9: a clean vulnerability DB, then a fresh download with retries across mirrors; fail closed. */
    freshDb({ attempts = 3, repos = DB_REPOS } = {}) {
      trivy(['clean', '--vuln-db']);
      const tries = [];
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = trivy(['image', '--download-db-only', '--db-repository', repos]);
        tries.push(r);
        if (r.ok) return { ok: true, status: 0, output: r.output, attempts: attempt };
      }
      return {
        ok: false,
        status: tries.at(-1).status,
        output: tries.map((t) => t.output).join('\n'),
        attempts,
      };
    },
    /** CS7: every HIGH/CRITICAL blocks, fixed or not (no ignore-unfixed); exceptions only via .trivyignore.yaml. */
    vulnerability: (tar) =>
      trivy([
        'image',
        ...tarInput(tar),
        '--skip-db-update',
        '--scanners',
        'vuln',
        '--severity',
        'HIGH,CRITICAL',
        '--ignorefile',
        '.trivyignore.yaml',
        '--exit-code',
        '1',
      ]),
    /** The full vulnerability report (all severities) for the summary and record. */
    vulnerabilityReport: (tar, out) =>
      trivy([
        'image',
        ...tarInput(tar),
        '--skip-db-update',
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--output',
        `/work/${out}`,
      ]),
    /** CS7: any secret, in the filesystem (node_modules included) or the image configuration and history. */
    secret: (tar) => trivy([...SECRET(tar), '--exit-code', '1']),
    /** The same secret scan as a JSON report (the canary proof reads where each finding was reported). */
    secretReport: (tar, out) =>
      trivy([...SECRET(tar), '--format', 'json', '--output', `/work/${out}`, '--exit-code', '0']),
    /** CS7: HIGH/CRITICAL misconfiguration of the image configuration. */
    misconfiguration: (tar) =>
      trivy([
        'image',
        ...tarInput(tar),
        '--skip-db-update',
        '--scanners',
        'misconfig',
        '--image-config-scanners',
        'misconfig',
        '--severity',
        'HIGH,CRITICAL',
        '--ignorefile',
        '.trivyignore.yaml',
        '--exit-code',
        '1',
      ]),
    /** CS7: HIGH/CRITICAL misconfiguration of the Dockerfiles in a directory (relative to the repository). */
    dockerfiles: (dir) =>
      trivy([
        'config',
        '--severity',
        'HIGH,CRITICAL',
        '--ignorefile',
        '.trivyignore.yaml',
        '--exit-code',
        '1',
        dir,
      ]),
    sbom: (tar, out) =>
      trivy([
        'image',
        ...tarInput(tar),
        '--skip-db-update',
        '--format',
        'spdx-json',
        '--output',
        `/work/${out}`,
      ]),
  };
}

/** CS6: save `image` and return its config digest (the identity every later stage re-checks). */
export async function savedConfig(image, work, name, { sh = realSh } = {}) {
  const tar = join(work, name);
  sh('docker', ['save', image, '-o', tar]);
  return configOf(JSON.parse((await readFromTar(tar, 'manifest.json')).toString('utf8')));
}

/** CS6: the tag still names the gated image. Returns { ok, output }. */
export async function sameImage(image, gatedConfig, work, { sh = realSh } = {}) {
  const tar = `recheck-${Date.now()}.tar`;
  const now = await savedConfig(image, work, tar, { sh });
  rmSync(join(work, tar), { force: true });
  return now === gatedConfig
    ? { ok: true, output: `${image} is still the gated image (config ${now})` }
    : {
        ok: false,
        output: `${image} changed since it was gated: config ${now}, not the gated ${gatedConfig} (CS6)`,
      };
}

/** CS6: what was pushed is the gated image. Returns { ok, output }. */
export function samePushed(ref, pushedConfig, gatedConfig) {
  return pushedConfig === gatedConfig
    ? { ok: true, output: `${ref} = the gated image (config ${pushedConfig})` }
    : {
        ok: false,
        output: `pushed ${ref} has config ${pushedConfig}, not the gated ${gatedConfig} (CS6)`,
      };
}
