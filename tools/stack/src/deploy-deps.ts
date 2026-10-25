// Spec 0019: the deploy's real steps (deploy.ts orders them and owns the LS3 guarantees). Secrets are rendered into
// STACK_DIR owner-only and reach containers only through env files and volumes; nothing here prints one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { COMPOSE_FILE, PROJECT, RELEASES, STACK_DIR, THIRD_PARTY, TUNNEL_IMAGE } from './config.js';
import type { DeployDeps } from './deploy.js';
import { nextState } from './state.js';
import { docker } from './docker.js';
import { acquireRegistryLock, verifyRelease } from './release.js';
import { envText, renderEnvFiles, renderPgBouncerIni, renderPgHba, renderS3Config, renderUserlist, renderValkeyConf, type StackSecrets } from './render.js';
import { ensureStackDir, loadSecrets, upgradeSecrets } from './secrets.js';
import { smoke } from './smoke.js';
import { ensureVault, envTokens, vaultState } from './vault.js';
import { realProtocolDeps } from './keys.js';
import { init as initLedger } from './ledger/commands.js';
import { recover as recoverLedger } from './ledger/protocol.js';
import { vaultStorage } from './vault-raft.js';
import { fillVolumes, markApplied, renderedDir } from './volumes.js';
import { realStatusInputs } from './backup/status-deps.js';
import { statusReport } from './backup/status.js';

const TRIVY_IMAGE = 'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';

export function compose(args: readonly string[], images: Readonly<Record<string, string>>) {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
  });
  return { status: r.status ?? 1 };
}

/** The env files in STACK_DIR, owner-only, with Vault's tokens once they exist (envTokens). */
export function writeEnvFiles(withVault: boolean): StackSecrets {
  ensureStackDir();
  for (const added of upgradeSecrets()) console.log(`[stack:deploy] secret added since this stack was initialised: ${added} (secrets.json, owner-only)`);
  const secrets = loadSecrets();
  for (const [name, file] of Object.entries(renderEnvFiles(secrets, envTokens(withVault)))) writeOwnerOnly(join(STACK_DIR, name), envText(file));
  return secrets;
}

function prepare(withVault: boolean): string[] {
  const secrets = writeEnvFiles(withVault);
  const rendered = renderedDir();
  mkdirSync(rendered, { recursive: true });
  const files: Record<string, string> = {
    'pg_hba.conf': renderPgHba(),
    'pgbouncer.ini': renderPgBouncerIni(),
    'userlist.txt': renderUserlist(secrets),
    'valkey.conf': renderValkeyConf(secrets),
    's3.json': renderS3Config(secrets),
  };
  for (const [name, text] of Object.entries(files)) writeOwnerOnly(join(rendered, name), text);
  return fillVolumes();
}

/**
 * D8: each third-party image's HIGH/CRITICAL count, reported; the deploy never blocks on them. A digest's result is
 * kept in STACK_DIR/scans.json and reported again without rescanning: the pins change only in a reviewed PR, and
 * Trivy fetching every image's layers on every deploy took minutes. A failed scan is reported and retried next time.
 */
function scanThirdParty(): string[] {
  const file = join(STACK_DIR, 'scans.json');
  const known: Record<string, { critical: number; high: number; scannedAt: string }> = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { critical: number; high: number; scannedAt: string }>) : {};
  const lines: string[] = [];
  // B4: the test tunnel's forwarder is reported with the stack's own images.
  for (const [name, ref] of Object.entries({ ...THIRD_PARTY, socat: TUNNEL_IMAGE })) {
    const seen = known[ref];
    if (seen) {
      lines.push(`[stack:deploy] D8 ${name}: CRITICAL ${String(seen.critical)}, HIGH ${String(seen.high)} (scanned ${seen.scannedAt.slice(0, 10)}; reported, not blocking)`);
      continue;
    }
    const r = docker(['run', '--rm', '-v', 'uv-trivy-cache:/root/.cache/trivy', TRIVY_IMAGE, 'image', '--quiet', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--format', 'json', ref], { allowFail: true });
    if (r.status !== 0) {
      lines.push(`[stack:deploy] D8 ${name}: scan failed (exit ${String(r.status)}: ${r.stderr.trim().split('\n').at(-1)?.slice(0, 160) ?? ''}); reported, not blocking`);
      continue;
    }
    const vulns = ((JSON.parse(r.stdout) as { Results?: { Vulnerabilities?: { Severity: string }[] }[] }).Results ?? []).flatMap((x) => x.Vulnerabilities ?? []);
    const count = (sev: string) => vulns.filter((v) => v.Severity === sev).length;
    known[ref] = { critical: count('CRITICAL'), high: count('HIGH'), scannedAt: new Date().toISOString() };
    lines.push(`[stack:deploy] D8 ${name}: CRITICAL ${String(known[ref].critical)}, HIGH ${String(known[ref].high)} (reported, not blocking)`);
  }
  writeFileSync(file, `${JSON.stringify(known, null, 2)}\n`);
  return lines;
}

/**
 * The quarantine and clean buckets (the API's defaults), through `weed shell` inside the SeaweedFS container: it
 * publishes no port, and its S3 identity is the app's. Idempotent. `weed shell` exits 0 even when a command fails,
 * and its master connection is flaky just after start (storage-dev.mjs, 2026-10-06), so the listing decides,
 * retried for up to a minute.
 * Spec 0020 A2-10: the shred ledger's evidence bucket is created with object lock (WORM and versioned; it can never be
 * turned off), owned by its own identity, the only one that writes it (a non-admin identity reaches only the buckets
 * it owns).
 */
export const BUCKETS: Readonly<Record<string, string>> = {
  'uv-quarantine': '',
  'uv-clean': '',
  'uv-shred-ledger': ' -withLock -owner univarse-shred-ledger',
};
function buckets(): string[] {
  const shell = (commands: string) =>
    docker(['exec', '-i', '-e', 'HOME=/tmp', `${PROJECT}-seaweedfs-1`, '/usr/bin/weed', 'shell', '-master=127.0.0.1:9333', '-filer=127.0.0.1:8888'], { input: `${commands}\n`, allowFail: true });
  const listed = () => new Set([...shell('s3.bucket.list').stdout.matchAll(/^\s*([a-z0-9-]{3,63})\s/gm)].map((m) => m[1]));
  let missing = Object.keys(BUCKETS);
  for (let i = 0; i < 20; i++) {
    const have = listed();
    missing = Object.keys(BUCKETS).filter((b) => !have.has(b));
    if (!missing.length) return [];
    shell(missing.map((b) => `s3.bucket.create -name ${b}${BUCKETS[b] ?? ''}`).join('\n'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return missing.map((b) => `bucket ${b} was not created (SeaweedFS)`);
}

function logs(): string {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'logs', '--no-color', '--tail', '30'], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, UNIVARSE_API_IMAGE: 'x', UNIVARSE_WEB_IMAGE: 'x', UNIVARSE_MIGRATE_IMAGE: 'x', UNIVARSE_PGBOUNCER_IMAGE: 'x' },
  });
  return r.stdout;
}

function saveState(images: Readonly<Record<string, string>>): void {
  const file = join(RELEASES, 'deploy-state.json');
  const prev: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  // `images`: the compose variables of what runs now, for `pnpm stack:keys` (spec 0020: the keys job runs the
  // deployed API image). images:prune reads only `current` and `rollback`.
  writeFileSync(file, `${JSON.stringify({ ...nextState(prev, images), images }, null, 2)}\n`);
}

/** Spec 0020 D8: a destruction in progress holds the ledger lock for a minute or two; the deploy waits for it. */
const DEPLOY_LEDGER_WAIT_MS = 10 * 60_000;
async function recover(images: Readonly<Record<string, string>>, { initLedger: init }: { initLedger: boolean }) {
  const deps = realProtocolDeps(images, { lockWaitMs: DEPLOY_LEDGER_WAIT_MS });
  const lines: string[] = [];
  if (init) {
    const r = await initLedger(deps);
    lines.push(...r.lines);
    if (!r.ok) return { ok: false, lines };
  }
  const r = await recoverLedger(deps, 'deploy');
  return { ok: r.ok, lines: [...lines, ...r.lines] };
}

/**
 * The local registry, for verification and pulls: the container every release runs (spec 0013's `registry`, the
 * dev compose's `release` profile). Started if stopped, and stopped again afterwards only if this started it. It is
 * started directly, never through the dev compose, so the deploy never reads the root .env (LS9). No container
 * means no release has ever run here, so there is nothing to deploy.
 */
const REGISTRY = 'univarse-dev-registry-1';
export function registry(): () => void {
  const state = docker(['inspect', '-f', '{{.State.Running}}', REGISTRY], { allowFail: true });
  if (state.status !== 0) throw new Error(`no local registry (${REGISTRY}): run \`pnpm images:release\` first`);
  if (state.stdout.trim() === 'true') return () => undefined;
  docker(['start', REGISTRY]);
  // Verification reaches it at once: wait for its healthcheck (up to 30 s).
  for (let i = 0; i < 60; i++) {
    if (docker(['inspect', '-f', '{{.State.Health.Status}}', REGISTRY], { allowFail: true }).stdout.trim() === 'healthy') break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return () => void docker(['stop', REGISTRY], { allowFail: true });
}

export function realDeps(): DeployDeps {
  return {
    registry,
    lock: (holder) => acquireRegistryLock(RELEASES, holder),
    verify: verifyRelease,
    prepare,
    markApplied: (services) => {
      markApplied({ services });
    },
    scanThirdParty,
    compose,
    vaultState: () => vaultState(),
    vaultStorage: () => vaultStorage(),
    ensureVault: () => void ensureVault(),
    buckets,
    recover,
    smoke,
    logs,
    saveState,
    backupWarnings: () => {
      try {
        return statusReport(realStatusInputs()).warnings;
      } catch (e) {
        return [`the backup status could not be read: ${(e as Error).message}`];
      }
    },
    log: (line) => console.log(line),
  };
}
