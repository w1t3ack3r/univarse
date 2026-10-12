// Spec 0013 CS4/CS5: how a UniVarse image is run in CI — one place, so the smoke run and the browser journeys
// use identical hardening. Values come from the repo-root .env plus the current environment and are passed as
// `-e NAME` only (the docker CLI reads the value from its own environment): no secret is ever on a command line.
import { existsSync } from 'node:fs';

const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** docs/09 §4.2, applied to every container: read-only root, UID 65532, no capabilities, no privilege gain. */
export const HARDENED = [
  '--read-only',
  '--user', '65532:65532',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
  '--network', 'host', // CI's services are on the runner's 127.0.0.1
];

// What the API and worker read (apps/api/src/config/config.ts), plus the web app's two variables.
const APP_ENV = [
  'PLATFORM_DATABASE_URL', 'VALKEY_URL', 'SESSION_PEPPER', 'DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY_ID', 'KEY_PROVIDER',
  'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_TRANSIT_MOUNT', 'VAULT_TRANSIT_KEY', 'SMTP_URL', 'MAIL_FROM', 'S3_ENDPOINT', 'S3_REGION',
  'S3_PUBLIC_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_QUARANTINE_BUCKET', 'S3_CLEAN_BUCKET', 'CLAMD_HOST', 'CLAMD_PORT',
  'CLAMD_TIMEOUT_MS', 'TRUSTED_PROXIES', 'WORKER_POLL_MS', 'FILE_SCAN_INTERVAL_MS', 'LOG_LEVEL',
  'API_INTERNAL_URL', 'STORAGE_UPLOAD_ORIGIN',
];

/**
 * The `docker run` arguments and the environment to spawn it with. `extra` values override the inherited ones;
 * only names that have a value are passed.
 */
export function dockerRun({ name, image, extra = {}, cmd = [], detach = false }) {
  const env = { ...process.env, ...extra };
  const names = [...new Set([...APP_ENV, ...Object.keys(process.env).filter((k) => /^TENANT_POOL_\d+_DATABASE_URL$/.test(k)), ...Object.keys(extra)])];
  const passed = names.filter((k) => env[k] !== undefined && env[k] !== '');
  const args = ['run', ...(detach ? ['-d'] : ['--rm']), '--name', name, ...HARDENED, ...passed.flatMap((k) => ['-e', k]), image, ...cmd];
  return { args, env };
}

export const WORKER_CMD = ['--enable-source-maps', '--import', './dist/otel.js', 'dist/worker.js'];
