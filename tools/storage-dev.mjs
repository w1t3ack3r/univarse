// DEV/CI ONLY (ADR-025, spec 0010). Local SeaweedFS for UniVarse.
//   node tools/storage-dev.mjs config    writes infra/compose/seaweedfs/s3.json from .env (before compose up)
//   node tools/storage-dev.mjs buckets   creates the quarantine and clean buckets (after compose up)
// Never prints a secret.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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

async function buckets() {
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
  await cors();
  console.log('SeaweedFS ready for UniVarse');
}

/**
 * Restrictive CORS on the quarantine bucket: tenant web origins, POST only (spec 0010 D1). SeaweedFS
 * stores this but does not enforce it (FU11 records that); the production provider does. Uploads are
 * protected by the signed policy, not by CORS.
 */
async function cors() {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    endpoint: envVal('S3_ENDPOINT') ?? 'http://127.0.0.1:8333',
    region: envVal('S3_REGION') ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: envVal('S3_ACCESS_KEY'), secretAccessKey: envVal('S3_SECRET_KEY') },
  });
  const origins = (envVal('STORAGE_CORS_ORIGINS') ?? 'http://*.univarse.localhost:4180,http://*.univarse.localhost:3000').split(',').map((o) => o.trim()).filter(Boolean);
  await s3.send(new PutBucketCorsCommand({
    Bucket: BUCKETS[0],
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['POST'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 }] },
  }));
  s3.destroy();
}

try {
  const cmd = process.argv[2];
  if (cmd === 'config') config();
  else if (cmd === 'buckets') await buckets();
  else throw new Error('usage: storage-dev.mjs config|buckets');
} catch (err) {
  console.error(`storage-dev: ${err.message}`);
  process.exit(1);
}
