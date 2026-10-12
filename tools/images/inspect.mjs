// Spec 0013 CS1/CS2: inspect a built image without running a shell in it (there is none).
//   node tools/images/inspect.mjs <image> --root app [--require-label revision]
// Checks: the configured user is 65532:65532; the OCI labels exist; no shell exists (by file listing, and by
// trying to run one); none of UniVarse's own source/test/env files are present; everything under the app root
// is root-owned and not group/other-writable. Exits non-zero naming every violation.
import { spawn, spawnSync } from 'node:child_process';
import { forbiddenReason, ownershipReason, SHELLS } from './rules.mjs';

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

/** A streaming ustar/pax/GNU tar header reader: calls onEntry({ path, type, uid, gid, mode }). */
function tarParser(onEntry) {
  let buf = Buffer.alloc(0);
  let skip = 0; // bytes of file data (rounded to 512) still to skip
  let paxPath = null;
  let gnuLong = null;
  let pending = null; // header waiting for its pax/longname data
  const oct = (b) => {
    const s = b.toString('latin1').replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) : 0;
  };
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          if (pending) pending.data.push(buf.subarray(0, n));
          buf = buf.subarray(n);
          skip -= n;
          if (skip > 0) return;
          if (pending) {
            const data = Buffer.concat(pending.data).subarray(0, pending.size).toString('utf8');
            if (pending.kind === 'x') {
              const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data);
              if (m) paxPath = m[1];
            } else gnuLong = data.replace(/\0+$/, '');
            pending = null;
          }
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) continue;
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const size = oct(h.subarray(124, 136));
        const flag = String.fromCharCode(h[156] || 48);
        const padded = Math.ceil(size / 512) * 512;
        if (flag === 'x' || flag === 'L') {
          pending = { kind: flag, size, data: [] };
          skip = padded;
          continue;
        }
        if (flag === 'g') {
          skip = padded;
          continue;
        }
        const path = paxPath ?? gnuLong ?? (prefix ? `${prefix}/${name}` : name);
        paxPath = null;
        gnuLong = null;
        const type = flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : 'file';
        onEntry({ path, type, size, uid: oct(h.subarray(108, 116)), gid: oct(h.subarray(116, 124)), mode: oct(h.subarray(100, 108)) });
        skip = padded;
      }
    },
  };
}
