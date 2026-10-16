// Spec 0017 PB10, the maintenance safeguard: fails when upstream has published a PgBouncer release newer than the
// pinned one. It can't catch a vulnerability disclosed against the latest release before another release exists
// (that's what the Grype match is for); it catches the opposite case, a fix already released that the pin lacks,
// which a scanner database built before the disclosure can't see.
// Upstream's releases are its `pgbouncer_X_Y_Z` tags, read with `git ls-remote` (no credentials, no API limit).
// Fails closed: a failed read, no release tags, or a pin that isn't among them is a failure, never "nothing newer".
// Run: node tools/images/pgbouncer-upstream.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DOCKERFILE, dockerfilePins } from './pgbouncer-inventory.mjs';

export const UPSTREAM_REPO = 'https://github.com/pgbouncer/pgbouncer';
const RELEASE_TAG = /^refs\/tags\/pgbouncer_(\d+)_(\d+)_(\d+)$/; // exact: re-tags such as `…-fixed` aren't releases
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** `git ls-remote --tags --refs` output → release versions ("1.26.1"), numerically sorted, without duplicates. */
export function releaseVersions(lsRemote) {
  const versions = new Set();
  for (const line of lsRemote.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    const m = ref ? RELEASE_TAG.exec(ref) : null;
    if (m) versions.add(`${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`);
  }
  return [...versions].sort(compareVersions);
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The pin against upstream's releases: { ok, newer, problems }. */
export function checkPin(pinned, releases) {
  const problems = [];
  if (!VERSION.test(pinned ?? ''))
    problems.push(`the pinned version is not X.Y.Z: ${String(pinned)}`);
  if (releases.length === 0) problems.push('no upstream release tags were read');
  if (problems.length) return { ok: false, newer: [], problems };
  if (!releases.includes(pinned))
    problems.push(
      `the pinned ${pinned} is not among upstream's releases (latest read: ${releases.at(-1)})`,
    );
  const newer = releases.filter((v) => compareVersions(v, pinned) > 0);
  if (newer.length)
    problems.push(
      `upstream has released PgBouncer ${newer.join(', ')}, newer than the pinned ${pinned}: update the pin (and its SHA-256) after reading the release notes`,
    );
  return { ok: problems.length === 0, newer, problems };
}

function main() {
  const { version } = dockerfilePins(readFileSync(DOCKERFILE, 'utf8'));
  const r = spawnSync('git', ['ls-remote', '--tags', '--refs', UPSTREAM_REPO], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) {
    console.error(
      `[pgbouncer-upstream] FAIL: git ls-remote ${UPSTREAM_REPO} failed (exit ${r.status ?? r.signal ?? r.error?.message}): ${String(r.stderr).trim()}`,
    );
    process.exit(1);
  }
  const releases = releaseVersions(r.stdout);
  const { ok, problems } = checkPin(version, releases);
  console.log(
    `[pgbouncer-upstream] pinned ${version}; ${releases.length} upstream releases read, latest ${releases.at(-1) ?? 'none'}`,
  );
  for (const p of problems) console.error(`[pgbouncer-upstream] FAIL: ${p}`);
  if (ok) console.log('[pgbouncer-upstream] PASS: no upstream release is newer than the pin');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
