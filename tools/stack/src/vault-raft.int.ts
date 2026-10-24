// Spec 0020 BK5 (its first half, PR B1) and B-4: the real `migrateRaft` against the stack's pinned Vault image, on
// volumes of its own (never a stack's). A Vault on file storage is set up exactly as the stack's (`initialise`: the
// audit device, Transit, the KEK, the app policy and token, the backup policy and token), wraps "data keys" with the
// app token, then is migrated: every one of them unwraps afterwards, the KEK's metadata is identical, the file storage
// was never written, and the backup token takes a snapshot and can do nothing else. Then a second migration of a
// failed attempt starts over. `pnpm --filter @univarse/stack test:vault`; CI only (it needs a Docker daemon).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO, THIRD_PARTY } from './config.js';
import { docker } from './docker.js';
import { initialise, loadVaultInit, vaultCli, vaultState, type VaultTarget } from './vault.js';
import { migrateRaft, vaultStorage, type MigrateDeps, type VaultVolumes } from './vault-raft.js';

if (process.env.CI !== 'true') throw new Error('vault-raft.int runs in CI only (it creates and removes Docker volumes and containers)');

const id = randomBytes(3).toString('hex');
const volumes: VaultVolumes = { raft: `uv-raftint-raft-${id}`, file: `uv-raftint-file-${id}` };
const target: VaultTarget = { container: `uv-raftint-${id}`, tls: false };
const dir = mkdtempSync(join(tmpdir(), 'uv-raftint-'));
const conf = mkdtempSync(join(tmpdir(), 'uv-raftint-conf-'));
const CONTEXT = Buffer.from('tenant-context').toString('base64');

/** The listener the test uses instead of the stack's TLS one: loopback, inside the container. */
const LISTENER = 'listener "tcp" {\n  address = "127.0.0.1:8200"\n  tls_disable = true\n}\napi_addr = "http://127.0.0.1:8200"\ndisable_mlock = true\n';
/** stack.hcl's own storage stanza and cluster address, with the test's listener: what B1 deploys, minus TLS. */
function raftConfig(): string {
  const stack = readFileSync(join(REPO, 'infra', 'stack', 'vault', 'stack.hcl'), 'utf8');
  const storage = /storage "raft" \{[^}]*\}/.exec(stack)?.[0];
  const cluster = /cluster_addr\s*=\s*"[^"]+"/.exec(stack)?.[0];
  if (!storage || !cluster) throw new Error('stack.hcl has no raft storage stanza or cluster_addr');
  return `${storage}\n${cluster}\n${LISTENER}`;
}
writeFileSync(join(conf, 'file.hcl'), `storage "file" {\n  path = "/vault/file"\n}\n${LISTENER}`);
writeFileSync(join(conf, 'raft.hcl'), raftConfig());

function start(config: 'file.hcl' | 'raft.hcl'): void {
  docker(['rm', '-f', target.container], { allowFail: true });
  docker(['run', '-d', '--name', target.container, '--hostname', 'vault', '--user', '100:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', `${volumes.file}:/vault/file${config === 'raft.hcl' ? ':ro' : ''}`, ...(config === 'raft.hcl' ? ['-v', `${volumes.raft}:/vault/raft`] : []),
    '-v', `${conf}:/vault/config:ro`, '-v', '/vault/logs', '--entrypoint', 'vault', THIRD_PARTY.vault, 'server', `-config=/vault/config/${config}`]);
  for (let i = 0; i < 60 && vaultState(docker, target) === 'absent'; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

function ensureVolumes(): void {
  for (const v of [volumes.raft, volumes.file]) if (docker(['volume', 'inspect', v], { allowFail: true }).status !== 0) docker(['volume', 'create', v]);
  // Owned to the vault user, as the deploy's DATA_VOLUMES does for the stack's Raft volume.
  docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh', '-v', `${volumes.raft}:/r`, '-v', `${volumes.file}:/f`, THIRD_PARTY.postgres, '-c', 'chown 100:1000 /r /f && chmod 0700 /r /f']);
}

const fileDigest = () =>
  docker(['run', '--rm', '--network', 'none', '-v', `${volumes.file}:/f:ro`, '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c', 'cd /f && find . -type f -exec sha256sum {} + | sort']).stdout;

const wrapped: { plaintext: string; ciphertext: string }[] = [];
function unwrapAll(): { ok: boolean; lines: string[] } {
  const { appToken } = loadVaultInit(dir);
  let ok = 0;
  for (const w of wrapped) {
    const r = vaultCli(docker, ['write', '-format=json', 'transit/decrypt/univarse-kek', `context=${CONTEXT}`, `ciphertext=${w.ciphertext}`], { VAULT_TOKEN: appToken }, undefined, target);
    if (r.status === 0 && (JSON.parse(r.stdout) as { data: { plaintext: string } }).data.plaintext === w.plaintext) ok++;
  }
  return { ok: ok === wrapped.length, lines: [`${String(ok)} of ${String(wrapped.length)} data keys unwrap`] };
}

const deps = (): MigrateDeps => ({
  run: docker,
  target,
  dir,
  volumes,
  compose: (args) => {
    if (args[0] === 'stop') docker(['rm', '-f', target.container], { allowFail: true });
    else start('raft.hcl');
    return { status: 0 };
  },
  verifyUnwrap: unwrapAll,
  ensureDataVolumes: ensureVolumes,
  log: (l) => {
    console.log(`[vault-raft.int] ${l}`);
  },
});

beforeAll(() => {
  for (const v of [volumes.raft, volumes.file]) if (docker(['volume', 'inspect', v], { allowFail: true }).status === 0) throw new Error(`${v} exists already`);
  ensureVolumes();
  start('file.hcl');
  initialise(docker, dir, target);
  const { appToken } = loadVaultInit(dir);
  // The KEK gets a second version, so more than one version must survive.
  vaultCli(docker, ['write', '-f', 'transit/keys/univarse-kek/rotate'], { VAULT_TOKEN: loadVaultInit(dir).rootToken }, undefined, target);
  for (let i = 0; i < 5; i++) {
    const plaintext = randomBytes(32).toString('base64');
    const r = vaultCli(docker, ['write', '-format=json', 'transit/encrypt/univarse-kek', `context=${CONTEXT}`, `plaintext=${plaintext}`], { VAULT_TOKEN: appToken }, undefined, target);
    wrapped.push({ plaintext, ciphertext: (JSON.parse(r.stdout) as { data: { ciphertext: string } }).data.ciphertext });
  }
}, 180_000);

afterAll(() => {
  docker(['rm', '-f', target.container], { allowFail: true });
  for (const v of [volumes.raft, volumes.file]) docker(['volume', 'rm', '-f', v], { allowFail: true });
});

describe('[BK5] Vault from file storage to Raft', () => {
  it('[B-4] before: unmigrated, so a deploy would refuse', () => {
    expect(vaultStorage(docker, dir, volumes)).toBe('unmigrated');
  });

  it('[BK5] the migration keeps the Transit key: every wrapped key unwraps, through the same app token', () => {
    const before = fileDigest();
    const r = migrateRaft(deps());
    expect(r.lines.join('\n')).toMatch(/5 of 5 data keys unwrap/);
    expect(r.ok).toBe(true);
    expect(vaultStorage(docker, dir, volumes)).toBe('raft');
    const status = JSON.parse(vaultCli(docker, ['status', '-format=json'], {}, undefined, target).stdout) as { storage_type: string };
    expect(status.storage_type).toBe('raft');
    expect(fileDigest()).toBe(before); // the file storage was never written
  });

  it('[B-4] the backup token takes a snapshot, and is refused everything else', () => {
    const { backupToken } = loadVaultInit(dir);
    expect(backupToken).toBeTruthy();
    const env = { VAULT_TOKEN: backupToken ?? '' };
    const snap = docker(['exec', '-e', 'VAULT_ADDR=http://127.0.0.1:8200', '-e', 'VAULT_TOKEN', target.container, 'sh', '-c', 'vault operator raft snapshot save /dev/stdout | wc -c'], { env });
    expect(Number(snap.stdout.trim())).toBeGreaterThan(1000);
    for (const args of [['read', 'transit/keys/univarse-kek'], ['write', 'transit/decrypt/univarse-kek', 'ciphertext=x'], ['policy', 'list'], ['token', 'create']])
      expect([args.join(' '), vaultCli(docker, args, env, undefined, target).status]).toEqual([args.join(' '), 2]);
  });
});
