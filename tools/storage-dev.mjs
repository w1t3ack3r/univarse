// DEV/CI ONLY (ADR-025, spec 0010). Local SeaweedFS for UniVarse.
//   node tools/storage-dev.mjs config    writes infra/compose/seaweedfs/s3.json from .env (before compose up)
//   node tools/storage-dev.mjs buckets   creates the quarantine and clean buckets (after compose up)
// Never prints a secret.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const envPath = new URL('../.env', import.meta.url);
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const envVal = (k) => process.env[k] ?? (env.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1];

const BUCKETS = [envVal('S3_QUARANTINE_BUCKET') ?? 'uv-quarantine', envVal('S3_CLEAN_BUCKET') ?? 'uv-clean'];

function config() {
  const accessKey = envVal('S3_ACCESS_KEY');
  const secretKey = envVal('S3_SECRET_KEY');
  if (!accessKey || !secretKey) throw new Error('S3_ACCESS_KEY / S3_SECRET_KEY missing: run pnpm dev:secrets');
  const dir = new URL('../infra/compose/seaweedfs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  // One identity for the app. Bucket-scoped least privilege is spec 0010's design note; SeaweedFS
  // actions can be narrowed per bucket (Read:bucket, Write:bucket) once the roles are split.
  const identity = { identities: [{ name: 'univarse-app', credentials: [{ accessKey, secretKey }], actions: ['Read', 'Write', 'List', 'Tagging', 'Admin'] }] };
  // 0644, not 0600: the container drops root to its own user (uid 1000), which on Linux (CI) cannot
  // read a 0600 file owned by the checkout's user, so the S3 gateway never starts. The file is
  // git-ignored, dev/CI only, and holds the same throwaway keys as .env.
  writeFileSync(new URL('s3.json', dir), JSON.stringify(identity, null, 2), { mode: 0o644 });
  chmodSync(new URL('s3.json', dir), 0o644);
  console.log('SeaweedFS identity written (infra/compose/seaweedfs/s3.json, git-ignored)');
}

/** The app's S3 client (same SDK as the API), against the local store. */
function s3Client() {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const sdk = require('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    endpoint: envVal('S3_ENDPOINT') ?? 'http://127.0.0.1:8333',
    region: envVal('S3_REGION') ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: envVal('S3_ACCESS_KEY'), secretAccessKey: envVal('S3_SECRET_KEY') },
  });
  return { sdk, client };
}

/**
 * Buckets through the S3 API itself (not `weed shell`, whose master connection is flaky right after
 * start: it failed CI on 2026-10-06). Retries until the S3 gateway answers; idempotent.
 */
async function buckets() {
  const { sdk, client } = s3Client();
  try {
    for (const b of BUCKETS) {
      if (!/^[a-z0-9-]{3,63}$/.test(b)) throw new Error(`Bad bucket name ${b}`);
      for (let i = 0; ; i++) {
        try {
          await client.send(new sdk.HeadBucketCommand({ Bucket: b }));
          break;
        } catch (err) {
          const status = err?.$metadata?.httpStatusCode;
          if (status === 404) {
            try {
              await client.send(new sdk.CreateBucketCommand({ Bucket: b }));
              console.log(`Bucket ${b} created`);
              break;
            } catch (createErr) {
              if (createErr?.name === 'BucketAlreadyOwnedByYou' || createErr?.name === 'BucketAlreadyExists') break;
              if (i >= 60) throw createErr;
            }
          } else if (i >= 60) {
            throw new Error(`S3 gateway not ready for ${b} (${err?.name ?? 'error'}: ${err?.code ?? err?.cause?.code ?? err?.message ?? ''})`, { cause: err });
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    await cors(sdk, client);
  } finally {
    client.destroy();
  }
  console.log('SeaweedFS ready for UniVarse');
}

/**
 * Restrictive CORS on the quarantine bucket: tenant web origins, POST only (spec 0010 D1). SeaweedFS
 * stores this but does not enforce it (FU11 records that); the production provider does. Uploads are
 * protected by the signed policy, not by CORS.
 */
async function cors(sdk, client) {
  const origins = (envVal('STORAGE_CORS_ORIGINS') ?? 'http://*.univarse.localhost:4180,http://*.univarse.localhost:3000').split(',').map((o) => o.trim()).filter(Boolean);
  await client.send(new sdk.PutBucketCorsCommand({
    Bucket: BUCKETS[0],
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['POST'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 }] },
  }));
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
