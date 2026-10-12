// Spec 0013 CS1/CS2: what may not be in a UniVarse image, and who may own it. Pure functions, so the rules are
// unit-tested (rules.test.mjs) apart from Docker. Only UNIVARSE's own paths are judged: third-party dependency
// files, including their `.d.ts`, are left alone (the owner's review of revision 3).

/** True when a path belongs to UniVarse: outside node_modules, or inside an @univarse workspace package. */
export function isOurs(path) {
  const p = path.replace(/^\.?\/+/, '');
  if (!p.includes('node_modules/')) return true;
  const last = p.lastIndexOf('node_modules/');
  return p.slice(last + 'node_modules/'.length).startsWith('@univarse/');
}

const FORBIDDEN_DIRS = ['src', 'e2e', 'docs', '.git', 'test', 'tests', '__tests__', 'testing'];

/** Why a path may not ship, or null. `root` is the app directory inside the image (e.g. "app"). */
export function forbiddenReason(path, root = 'app') {
  const p = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!(p === root || p.startsWith(`${root}/`))) return null; // the base image's own files aren't ours to judge
  if (!isOurs(p)) return null;
  const segments = p.split('/');
  const name = segments.at(-1) ?? '';
  // Directories that hold our source or tests, at any depth of our own tree (dist/testing included).
  for (const s of segments.slice(1, -1).concat(name)) {
    if (FORBIDDEN_DIRS.includes(s) && !(s === 'src' && isNextBuildPath(segments))) return `UniVarse ${s}/ directory`;
  }
  if (/^\.env(\..*)?$/.test(name)) return 'environment file';
  if (/\.(int\.)?spec\.[cm]?[jt]sx?$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) return 'test file';
  if (/\.[cm]?tsx?$/.test(name) && !/\.d\.[cm]?ts$/.test(name)) return 'UniVarse TypeScript source';
  if (/\.(pem|key)$/.test(name)) return 'key material';
  return null;
}

// Next.js build output can contain route segments literally named after source folders; nothing under
// `.next/` is source.
function isNextBuildPath(segments) {
  return segments.includes('.next');
}

/** Why an entry's ownership or mode is wrong, or null: root-owned, never writable by the app user. */
export function ownershipReason(entry, appUid = 65532) {
  if (entry.type === 'symlink') return null; // a link's own mode is meaningless
  if (entry.uid !== 0 || entry.gid !== 0) return `owned by ${entry.uid}:${entry.gid}, not root`;
  if (entry.uid === appUid) return 'owned by the app user';
  if ((entry.mode & 0o022) !== 0) return `group/other-writable (mode ${(entry.mode & 0o7777).toString(8)})`;
  return null;
}

export const SHELLS = ['bin/sh', 'bin/bash', 'bin/dash', 'bin/ash', 'bin/busybox', 'usr/bin/sh', 'usr/bin/bash', 'usr/bin/dash'];
