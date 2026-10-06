// DEV/CI ONLY (ADR-025, spec 0010). Local SeaweedFS for UniVarse.
//   node tools/storage-dev.mjs config    writes infra/compose/seaweedfs/s3.json from .env (before compose up)
//   node tools/storage-dev.mjs buckets   creates the quarantine and clean buckets (after compose up)
// Never prints a secret.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const envPath = new URL('../.env', import.meta.url);
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const envVal = (k) => process.env[k] ?? (env.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1];

const BUCKETS = [envVal('S3_QUARANTINE_BUCKET') ?? 'uv-quarantine', envVal('S3_CLEAN_BUCKET') ?? 'uv-clean'];
const CONTAINER = process.env.SEAWEEDFS_CONTAINER ?? 'univarse-dev-seaweedfs-1';

function config() {
  const accessKey = envVal('S3_ACCESS_KEY');
  const secretKey = envVal('S3_SECRET_KEY');
  if (!accessKey || !secretKey) throw new Error('S3_ACCESS_KEY / S3_SECRET_KEY missing: run pnpm dev:secrets');
  const dir = new URL('../infra/compose/seaweedfs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  // One identity for the app. Bucket-scoped least privilege is spec 0010's design note; SeaweedFS
  // actions can be narrowed per bucket (Read:bucket, Write:bucket) once the roles are split.
  const identity = { identities: [{ name: 'univarse-app', credentials: [{ accessKey, secretKey }], actions: ['Read', 'Write', 'List', 'Tagging', 'Admin'] }] };
  writeFileSync(new URL('s3.json', dir), JSON.stringify(identity, null, 2), { mode: 0o600 });
  console.log('SeaweedFS identity written (infra/compose/seaweedfs/s3.json, git-ignored)');
}

function buckets() {
  for (let i = 0; i < 30; i++) {
    try {
      execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'echo "s3.bucket.list" | weed shell'], { stdio: 'pipe' });
      break;
    } catch {
      if (i === 29) throw new Error(`SeaweedFS not ready (${CONTAINER})`);
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  const list = execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'echo "s3.bucket.list" | weed shell'], { encoding: 'utf8' });
  for (const b of BUCKETS) {
    if (!/^[a-z0-9-]{3,63}$/.test(b)) throw new Error(`Bad bucket name ${b}`);
    if (list.includes(b)) continue;
    execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', `echo "s3.bucket.create -name ${b}" | weed shell`], { stdio: 'pipe' });
    console.log(`Bucket ${b} created`);
  }
  console.log('SeaweedFS ready for UniVarse');
}

try {
  const cmd = process.argv[2];
  if (cmd === 'config') config();
  else if (cmd === 'buckets') buckets();
  else throw new Error('usage: storage-dev.mjs config|buckets');
} catch (err) {
  console.error(`storage-dev: ${err.message}`);
  process.exit(1);
}
