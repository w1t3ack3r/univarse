// Spec 0013 CS1/CS2: inspect a built image without running a shell in it (there is none).
//   node tools/images/inspect.mjs <image> --root app [--require-label revision]
// Checks: the configured user is 65532:65532; the OCI labels exist; no shell exists (by file listing, and by
// trying to run one); none of UniVarse's own source/test/env files are present; everything under the app root
// is root-owned and not group/other-writable. Exits non-zero naming every violation.
import { spawn, spawnSync } from 'node:child_process';
import { forbiddenReason, ownershipReason, SHELLS } from './rules.mjs';
import { tarParser } from './tar.mjs';

const [image, ...rest] = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const root = arg('root', 'app');
if (!image) {
  console.error('usage: inspect.mjs <image> --root app');
  process.exit(2);
}

const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const problems = [];

// 1. Configuration: user and labels.
const [meta] = JSON.parse(docker('image', 'inspect', image));
const config = meta.Config ?? {};
if (config.User !== '65532:65532') problems.push(`user is "${config.User}", expected "65532:65532"`);
for (const l of ['source', 'revision', 'created', 'version']) {
  const v = config.Labels?.[`org.opencontainers.image.${l}`];
  if (!v || v === 'unknown') problems.push(`label org.opencontainers.image.${l} missing or unknown`);
}

// 2. The filesystem, as Docker exports it: a tar stream, read with a minimal parser (no tar binary needed).
const id = docker('create', image);
const entries = [];
try {
  await new Promise((resolve, reject) => {
    const p = spawn('docker', ['export', id]);
    const parser = tarParser((e) => entries.push(e));
    p.stdout.on('data', (b) => parser.push(b));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker export exited ${code}`))));
  });
} finally {
  docker('rm', id);
}

const paths = new Set(entries.map((e) => e.path.replace(/^\.?\/+/, '').replace(/\/+$/, '')));
for (const s of SHELLS) if (paths.has(s)) problems.push(`shell present: /${s}`);
for (const e of entries) {
  const p = e.path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const why = forbiddenReason(p, root);
  if (why) problems.push(`${why}: /${p}`);
  if (p === root || p.startsWith(`${root}/`)) {
    const own = ownershipReason(e);
    if (own) problems.push(`${own}: /${p}`);
  }
}

// 3. No shell, by trying to run one: it must fail to start.
const sh = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', 'true'], { encoding: 'utf8' });
if (sh.status === 0) problems.push('running "sh" succeeded: the image has a shell');

const appFiles = entries.filter((e) => e.type === 'file' && e.path.replace(/^\.?\/+/, '').startsWith(`${root}/`)).length;
console.log(`[inspect] ${image}: user ${config.User}; ${entries.length} entries, ${appFiles} files under /${root}; image id ${meta.Id}`);
// Where the size goes (spec 0013 CS16 evidence): the largest packages in the app's node_modules.
const bySize = new Map();
for (const e of entries) {
  const m = /^\.?\/?(?:[^/]+\/)*?node_modules\/\.pnpm\/([^/]+)\//.exec(e.path);
  if (m && e.type === 'file') bySize.set(m[1], (bySize.get(m[1]) ?? 0) + (e.size ?? 0));
}
const top = [...bySize].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)} MB`);
if (top.length > 0) console.log(`[inspect] largest packages: ${top.join('; ')}`);

if (problems.length > 0) {
  // Long lists are summarised by reason; the first few paths of each are shown.
  const byReason = new Map();
  for (const p of problems) {
    const k = p.split(': /')[0];
    byReason.set(k, [...(byReason.get(k) ?? []), p]);
  }
  for (const [k, list] of byReason) console.error(`[inspect] FAIL ${k} (${list.length}): ${list.slice(0, 5).join(' | ')}`);
  process.exit(1);
}
console.log('[inspect] PASS: user, labels, no shell, no UniVarse source/test/env files, root-owned and not writable');
