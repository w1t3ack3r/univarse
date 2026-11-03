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

/**
 * CS9: a release may reuse the vulnerability database already in the cache only when it was downloaded in the last
 * 6 hours (Trivy rebuilds it about every 6) and built in the last day. Anything else, or anything unreadable, means a
 * fresh download. So the owner can fetch it ahead of a release on a slow connection, and never scan with older data
 * than a fresh download would get.
 */
export const DB_REUSE = { maxDownloadAgeMs: 6 * 60 * 60 * 1000, maxBuiltAgeMs: 24 * 60 * 60 * 1000 };

/** Whether the cached database (`trivy version`'s VulnerabilityDB: UpdatedAt, DownloadedAt) may be reused. */
export function reusableDb(meta, now = Date.now(), limits = DB_REUSE) {
  const downloaded = Date.parse(meta?.downloadedAt ?? '');
  const built = Date.parse(meta?.updatedAt ?? '');
  if (Number.isNaN(downloaded) || Number.isNaN(built)) return { ok: false, why: 'no readable vulnerability database in the cache' };
  if (downloaded > now + 60_000 || built > now + 60_000) return { ok: false, why: 'the cached database is dated in the future' };
  const hours = (ms) => `${(ms / 3_600_000).toFixed(1)} h`;
  if (now - downloaded > limits.maxDownloadAgeMs)
    return { ok: false, why: `the cached database was downloaded ${hours(now - downloaded)} ago, over ${hours(limits.maxDownloadAgeMs)}` };
  if (now - built > limits.maxBuiltAgeMs)
    return { ok: false, why: `the cached database was built ${hours(now - built)} ago, over ${hours(limits.maxBuiltAgeMs)}` };
  return { ok: true, why: `downloaded ${hours(now - downloaded)} ago, built ${hours(now - built)} ago` };
}

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
  // `opts.live`: Trivy's own output goes straight to this terminal (with a TTY when there is one, so its progress bar
  // draws), instead of being captured.
  const trivyRun = (args, opts = {}) =>
    sh(
      'docker',
      [
        'run',
        '--rm',
        ...(opts.live && process.stdout.isTTY ? ['-t'] : []),
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
      { allowFail: true, ...(opts.live ? { stdio: 'inherit' } : {}) },
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
    /** CS9: the cached database's dates (`trivy version`), or null if there is none or it can't be read. */
    dbMeta() {
      const r = trivyRun(['version', '--format', 'json']);
      if (r.status !== 0) return null;
      try {
        const db = JSON.parse(r.stdout).VulnerabilityDB ?? {};
        return { updatedAt: db.UpdatedAt ?? null, downloadedAt: db.DownloadedAt ?? null };
      } catch {
        return null;
      }
    },
    /**
     * CS7/CS9: a clean vulnerability DB, then a fresh download with retries across mirrors; fail closed. `progress`
     * shows the download and Trivy's own errors live (the release); otherwise they're captured (the proofs).
     */
    freshDb({ attempts = 3, repos = DB_REPOS, progress = false } = {}) {
      // The old DB must really be gone: if it can't be removed, a "fresh" download could leave stale data in use.
      const clean = trivy(['clean', '--vuln-db']);
      if (!clean.ok) {
        return {
          ok: false,
          status: clean.status,
          output: clean.output,
          attempts: 0,
          why: 'could not remove the old vulnerability database',
        };
      }
      const tries = [];
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = progress
          ? result(trivyRun(['image', '--download-db-only', '--db-repository', repos], { live: true }))
          : trivy(['image', '--download-db-only', '--db-repository', repos]);
        tries.push(r);
        if (r.ok) return { ok: true, status: 0, output: r.output, attempts: attempt };
      }
      return {
        ok: false,
        status: tries.at(-1).status,
        output: tries.map((t) => t.output).join('\n'),
        attempts,
        why: `could not download a fresh vulnerability database after ${attempts} attempts`,
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
  let now;
  try {
    now = await savedConfig(image, work, tar, { sh }); // a malformed or truncated save rejects to the caller
  } finally {
    rmSync(join(work, tar), { force: true });
  }
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
