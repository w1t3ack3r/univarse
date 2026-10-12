// Spec 0013 local release (ADR-030): shared pieces for `pnpm images:release` and the verification the local
// deploy runs (LR9). Tools run as pinned containers (L2); nothing is installed on the host.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const TRIVY_IMAGE = 'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
export const COSIGN_IMAGE = 'ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8';
export const COMPOSE = ['compose', '-f', 'infra/compose/compose.dev.yml', '--env-file', '.env'];
export const RELEASE_NETWORK = 'univarse-dev_release'; // internal: true (compose.dev.yml)
export const HOST_REGISTRY = 'localhost:5000'; // where the host's Docker pushes
export const TOOL_REGISTRY = 'registry:5000'; // how the offline tools reach the same registry
export const DEFAULT_KEY = join(homedir(), '.univarse', 'signing', 'cosign.key');
export const DEFAULT_PUB = join(REPO, 'infra', 'signing', 'cosign.pub');
/**
 * The ONLY images a release may contain, with their repositories and Dockerfiles. Trusted code: verification
 * compares records and provenance against this table, never against the record's own (editable) values.
 */
export const ROLES = Object.freeze({
  api: Object.freeze({ repo: 'univarse-api', dockerfile: 'infra/docker/api.Dockerfile' }),
  web: Object.freeze({ repo: 'univarse-web', dockerfile: 'infra/docker/web.Dockerfile' }),
});
/** Every container a release starts carries this label with the run's ID; cleanup removes only those (LR10). */
export const RUN_LABEL = 'univarse.release.run';
/** Container-name suffix for this release run ('' outside a release, e.g. in CI, where names stay as they were). */
export const runSuffix = () => (process.env.UV_RELEASE_RUN ? `-${process.env.UV_RELEASE_RUN}` : '');
export const IDENTITY = 'keyless@distroless.iam.gserviceaccount.com';
export const IDENTITY_ISSUER = 'https://accounts.google.com';

// LR5: strictly local signing. No transparency-log upload and no signing-config/trusted-root fetch when signing;
// verification against the key alone. The registry is plain HTTP on the internal network.
export const SIGN_FLAGS = ['--tlog-upload=false', '--use-signing-config=false', '--allow-http-registry', '--yes'];
export const VERIFY_FLAGS = ['--insecure-ignore-tlog=true', '--allow-http-registry'];
export const PREDICATES = { sbom: 'spdxjson', provenance: 'slsaprovenance1' };

/** Docker paths: Windows host paths as Docker Desktop wants them; container paths untouched (no MSYS rewriting). */
export const hostPath = (p) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);

/** Runs a command; returns { status, stdout, stderr }. Throws on non-zero unless allowFail. */
export function sh(cmd, args, { env, allowFail = false, stdio, cwd = REPO, input } = {}) {
  // pnpm is a .cmd shim on Windows, which Node can only start through a shell. Arguments here are fixed strings.
  const shell = process.platform === 'win32' && cmd === 'pnpm';
  const r = spawnSync(cmd, args, { cwd, shell, env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env }, encoding: 'utf8', stdio, input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const err = (r.stderr || r.stdout || '').trim().split('\n').slice(-12).join('\n');
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} … exited ${r.status}\n${err}`);
  }
  return r;
}

/**
 * cosign in its pinned container. `offline` attaches it ONLY to the internal release network (LR5): it can reach
 * the local registry and nothing else. Keys are mounted read-only; the password is passed by name only.
 */
export function cosign(args, { offline = true, mounts = [], env = {}, allowFail = false } = {}) {
  const net = offline ? ['--network', RELEASE_NETWORK] : [];
  const vols = mounts.flatMap(([host, ctr]) => ['-v', `${hostPath(host)}:${ctr}:ro`]);
  const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
  return sh('docker', ['run', '--rm', ...net, ...vols, ...envArgs, COSIGN_IMAGE, ...args], { env, allowFail });
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

/** The digest the local registry holds for repo:tag (the registry is the source of truth, not `docker inspect`). */
export async function registryDigest(repo, tag) {
  const r = await fetch(`http://127.0.0.1:5000/v2/${repo}/manifests/${tag}`, { method: 'HEAD', headers: { accept: MANIFEST_TYPES } });
  if (!r.ok) throw new Error(`registry HEAD ${repo}:${tag} → ${r.status}`);
  const d = r.headers.get('docker-content-digest');
  if (!d) throw new Error(`registry gave no digest for ${repo}:${tag}`);
  return d;
}

/** The config digest of the image manifest at repo@digest (a single-platform manifest; the release builds no index). */
export async function registryConfigDigest(repo, digest) {
  const r = await fetch(`http://127.0.0.1:5000/v2/${repo}/manifests/${digest}`, { headers: { accept: MANIFEST_TYPES } });
  if (!r.ok) throw new Error(`registry GET ${repo}@${digest} → ${r.status}`);
  const m = await r.json();
  if (!m.config?.digest) throw new Error(`${repo}@${digest} is not a single image manifest (mediaType ${m.mediaType})`);
  return m.config.digest;
}

/** Decodes the in-toto predicate from `cosign verify-attestation` output (one JSON envelope per line). */
export function predicatesFrom(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(Buffer.from(JSON.parse(l).payload, 'base64').toString('utf8')).predicate);
}
