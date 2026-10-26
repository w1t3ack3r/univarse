// Spec 0024 H2: the pre-commit hook's gitleaks, the same version as CI's, fetched once and checksum-verified before
// it is ever unpacked or run. `pnpm tools:gitleaks` fetches it into .tools/ (git-ignored); the hook never fetches.
//   node tools/hooks/gitleaks.mjs           fetch it, unless it is already there
// The checksums are gitleaks 8.30.1's published gitleaks_8.30.1_checksums.txt; its linux_x64 line is the one CI pins.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '8.30.1';
export const ASSETS = {
  'linux-x64': ['linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
  'linux-arm64': ['linux_arm64.tar.gz', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'],
  'darwin-x64': ['darwin_x64.tar.gz', 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'],
  'darwin-arm64': ['darwin_arm64.tar.gz', 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'],
  'win32-x64': ['windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'],
  'win32-arm64': ['windows_arm64.zip', 'b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f'],
};

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DIR = join(ROOT, '.tools', `gitleaks-${VERSION}`);
export const binary = (platform = process.platform) => join(DIR, platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');

/** The asset and its checksum for a platform, or the reason there is none. */
export function assetFor(platform, arch) {
  const a = ASSETS[`${platform}-${arch}`];
  if (!a) return { problem: `no pinned gitleaks ${VERSION} for ${platform}-${arch}; add its checksum to tools/hooks/gitleaks.mjs` };
  const [suffix, sha256] = a;
  return { name: `gitleaks_${VERSION}_${suffix}`, sha256, url: `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${suffix}` };
}

/** Whether the bytes are the pinned archive. */
export const verified = (bytes, sha256) => createHash('sha256').update(bytes).digest('hex') === sha256;

async function fetchGitleaks() {
  if (existsSync(binary())) {
    console.log(`gitleaks ${VERSION} is already in .tools/ (${binary()}).`);
    return 0;
  }
  const asset = assetFor(process.platform, process.arch);
  if (asset.problem) {
    console.error(asset.problem);
    return 1;
  }
  const res = await fetch(asset.url);
  if (!res.ok) {
    console.error(`gitleaks: downloading ${asset.name} failed (HTTP ${String(res.status)})`);
    return 1;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // Never unpacked, let alone run, unless it is byte for byte the pinned release.
  if (!verified(bytes, asset.sha256)) {
    console.error(`gitleaks: ${asset.name} does not match its pinned SHA-256; nothing was unpacked`);
    return 1;
  }
  mkdirSync(join(ROOT, '.tools'), { recursive: true });
  const tmp = mkdtempSync(join(ROOT, '.tools', 'gitleaks-'));
  try {
    const archive = join(tmp, asset.name);
    // codeql[js/http-to-file-access]: written only after its SHA-256 matched the pinned release above; tar needs a file
    writeFileSync(archive, bytes);
    // Windows' own tar (bsdtar, in Windows 10 and later) reads zip archives. It is named in full: under Git Bash, the
    // `tar` on PATH is GNU tar, which reads neither zips nor a path starting `C:`.
    const exe = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const x = spawnSync(tar, ['-xf', archive, '-C', tmp, exe], { stdio: 'inherit' });
    if (x.status !== 0) {
      console.error(`gitleaks: unpacking ${asset.name} failed`);
      return 1;
    }
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    renameSync(join(tmp, exe), binary());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`gitleaks ${VERSION}, SHA-256 verified, is in ${binary()}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await fetchGitleaks());
