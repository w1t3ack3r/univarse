// Spec 0013 CS4/CS5: how a UniVarse image is run in CI — one place, so the smoke run and the browser journeys
// use identical hardening. Values come from the repo-root .env plus the current environment and are passed as
// `-e NAME` only (the docker CLI reads the value from its own environment): no secret is ever on a command line.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { VAULT_CA, VAULT_TLS_ADDR } from './vault-tls.mjs';

export { VAULT_CA, VAULT_TLS_ADDR };

const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
// Spec 0016 IO17: the relay role's URL, for the WORKER container only. Read from .env.worker (never loaded into this
// process's environment), so the API container can never inherit it.
const workerEnv = new URL('../../.env.worker', import.meta.url);
const workerOnly = () => {
  const v = existsSync(workerEnv) ? parseEnv(readFileSync(workerEnv, 'utf8')).PLATFORM_RELAY_URL : undefined;
  return v ? { PLATFORM_RELAY_URL: v } : {};
};

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
 * Spec 0019 C1: the images run in production mode, where a plaintext VAULT_ADDR is refused, loopback included. So they
 * reach the dev Vault on its TLS listener (vault-tls.mjs), trusting the throwaway dev CA mounted read-only;
 * verification stays on. The dev Vault's plain listener (8200) is never handed to an image.
 */
const VAULT_CA_IN = '/etc/univarse/vault-ca.crt';

/**
 * The `docker run` arguments and the environment to spawn it with. `extra` values override the inherited ones;
 * only names that have a value are passed.
 */
export function dockerRun({ name, image, extra = {}, cmd = [], detach = false, caFile = VAULT_CA }) {
  if (!existsSync(caFile)) throw new Error(`no dev Vault CA at ${caFile}: run pnpm dev:infra (it makes the TLS listener's certificate)`);
  const isWorker = cmd === WORKER_CMD;
  const { PLATFORM_RELAY_URL: _never, ...inherited } = process.env;
  const vaultTls = { VAULT_ADDR: VAULT_TLS_ADDR, NODE_EXTRA_CA_CERTS: VAULT_CA_IN };
  const env = { ...inherited, ...(isWorker ? workerOnly() : {}), ...vaultTls, ...extra, MSYS_NO_PATHCONV: '1' };
  const names = [
    ...new Set([
      ...APP_ENV,
      ...Object.keys(vaultTls),
      ...Object.keys(process.env).filter((k) => /^TENANT_POOL_\d+_DATABASE_URL$/.test(k)),
      ...(isWorker ? ['PLATFORM_RELAY_URL'] : []),
      ...Object.keys(extra),
    ]),
  ].filter((k) => isWorker || k !== 'PLATFORM_RELAY_URL');
  const passed = names.filter((k) => env[k] !== undefined && env[k] !== '');
  // Inside a release run, every container is labelled with the run's ID so cleanup removes only what this run owns.
  const owner = process.env.UV_RELEASE_RUN ? ['--label', `univarse.release.run=${process.env.UV_RELEASE_RUN}`] : [];
  const ca = ['-v', `${caFile}:${VAULT_CA_IN}:ro`];
  const args = ['run', ...(detach ? ['-d'] : ['--rm']), '--name', name, ...owner, ...HARDENED, ...ca, ...passed.flatMap((k) => ['-e', k]), image, ...cmd];
  return { args, env };
}

export const WORKER_CMD = ['--enable-source-maps', '--import', './dist/otel.js', 'dist/worker.js'];
