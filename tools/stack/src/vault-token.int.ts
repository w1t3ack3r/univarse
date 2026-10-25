// Spec 0023: the Vault tokens' lifecycle on a THROWAWAY Vault, never the stack's: the stack's pinned image in server
// mode (file storage on tmpfs, initialised and unsealed), set up by the stack's own code (vault.ts), and reached by the
// app's own provider and renewer (packages/crypto). Its listener is published on 127.0.0.1 for this test only, in
// plain HTTP (TLS is spec 0019 C2's, checked on the stack). It pins Vault's own answers for a dead token and a
// sealed Vault, which the classification relies on. `pnpm --filter @univarse/stack test:vault`; CI only.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VaultTransitProvider, wrapContext } from '../../../packages/crypto/src/providers.js';
import { VaultTokenRenewer, type RenewerLog } from '../../../packages/crypto/src/token-renewal.js';
import { THIRD_PARTY } from './config.js';
import { docker } from './docker.js';
import {
  classifyVaultFailure,
  configure,
  ensureVault,
  initialise,
  loadVaultInit,
  lookupToken,
  renewToken,
  renewTokens,
  SEALED_LINE,
  tokenReport,
  tokenStates,
  unseal,
  vaultCli,
  vaultState,
  type VaultTarget,
} from './vault.js';

if (process.env.CI !== 'true') throw new Error('vault-token.int runs in CI only (it starts and removes a Docker container)');

const NAME = `uv-vault-token-${randomBytes(4).toString('hex')}`;
const TARGET: VaultTarget = { container: NAME, tls: false };
const HCL = 'storage "file" { path = "/vault/file" }\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_disable = true\n}\ndisable_mlock = true\nui = false';
const PERIOD_S = 2764800;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet: RenewerLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

let dir: string;
let addr: string;
/** A second stack directory on the same Vault: its root token, and tokens of a few seconds (configure's test option). */
function shortLived(periodS: number): string {
  const d = mkdtempSync(join(tmpdir(), 'uv-vault-token-short-'));
  const { unsealKey, rootToken } = loadVaultInit(dir);
  writeFileSync(join(d, 'vault-init.json'), JSON.stringify({ unsealKey, rootToken, appToken: '' }));
  configure(docker, d, TARGET, { period: `${String(periodS)}s` });
  return d;
}
const app = (d: string) => ({ VAULT_TOKEN: loadVaultInit(d).appToken });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uv-vault-token-'));
  docker([
    'run', '-d', '--name', NAME, '--user', '100:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/vault/file:uid=100,gid=1000', '--tmpfs', '/tmp:uid=100,gid=1000', '--tmpfs', '/vault/logs:uid=100,gid=1000', '-p', '127.0.0.1::8200',
    '--entrypoint', 'sh', THIRD_PARTY.vault, '-c', `printf '%s\\n' '${HCL}' > /tmp/v.hcl && exec vault server -config=/tmp/v.hcl`,
  ]);
  for (let i = 0; i < 40 && vaultState(docker, TARGET) !== 'uninitialised'; i++) await pause(500);
  initialise(docker, dir, TARGET);
  const port = docker(['port', NAME, '8200/tcp']).stdout.trim().split('\n')[0]?.split(':').at(-1) ?? '';
  addr = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(() => {
  docker(['rm', '-f', NAME], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('[0023] the tokens on a real Vault', () => {
  it('[T6] both tokens are periodic at 768 h, each saved with its accessor', () => {
    const init = loadVaultInit(dir);
    for (const [token, accessor] of [[init.appToken, init.appTokenAccessor], [init.backupToken ?? '', init.backupTokenAccessor]] as const) {
      const l = lookupToken(docker, init.rootToken, token, TARGET);
      if (!l.ok) throw new Error(JSON.stringify(l.failure));
      expect(l.info.period).toBe(PERIOD_S);
      expect(l.info.accessor).toBe(accessor);
    }
    expect(JSON.stringify(readFileSync(join(dir, 'vault-init.json'), 'utf8'))).toContain('appTokenAccessor');
  });

  it('[T3] renewal resets both TTLs to the full period', async () => {
    await pause(3000);
    expect(renewTokens(docker, dir, TARGET).ok).toBe(true);
    const r = tokenReport(tokenStates(docker, dir, TARGET));
    expect(r.problems).toEqual([]);
    for (const s of tokenStates(docker, dir, TARGET)) if ('info' in s) expect(s.info.ttlSeconds).toBeGreaterThan(PERIOD_S - 30);
  });

  it("[T1] each token renews and looks up itself, and is still refused everything else it wasn't given", () => {
    const init = loadVaultInit(dir);
    const status = (token: string, args: string[]) => vaultCli(docker, args, { VAULT_TOKEN: token }, undefined, TARGET).status;
    for (const token of [init.appToken, init.backupToken ?? '']) {
      expect(status(token, ['token', 'renew', '-format=json'])).toBe(0);
      expect(status(token, ['token', 'lookup', '-format=json'])).toBe(0);
      expect(status(token, ['read', 'sys/mounts'])).toBe(2);
      expect(status(token, ['token', 'create'])).toBe(2);
      expect(status(token, ['write', 'transit/keys/another', 'type=aes256-gcm96'])).toBe(2);
    }
    expect(status(init.appToken, ['read', 'sys/storage/raft/snapshot'])).toBe(2);
    expect(status(init.backupToken ?? '', ['write', 'transit/encrypt/univarse-kek', `plaintext=${randomBytes(8).toString('base64')}`])).toBe(2);
  });

  it("[T4] Vault's answers, pinned: a dead token is a \"bad token\" to the root's lookup; configure re-issues it, and the app's provider works with the new one", async () => {
    const d = shortLived(4);
    const dead = loadVaultInit(d);
    await pause(7000);
    const l = lookupToken(docker, dead.rootToken, dead.appToken, TARGET);
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.failure).toEqual({ kind: 'bad_token' });
    // The dead token's own renewal fails too, in whatever words this Vault uses (recorded, not relied on).
    const own = renewToken(docker, dead.appToken, TARGET);
    expect(own.ok).toBe(false);
    if (!own.ok) console.log(`[vault-token.int] a dead token renewing itself: ${JSON.stringify(own.failure)}`);
    // T4: re-issued at the normal period, saved, and working through the app's own provider.
    const c = configure(docker, d, TARGET);
    expect(c.reissued).toEqual(['app', 'backup']);
    const fresh = loadVaultInit(d);
    expect(fresh.appToken).not.toBe(dead.appToken);
    expect(fresh.appTokenAccessor).not.toBe(dead.appTokenAccessor);
    const provider = new VaultTransitProvider({ addr, token: fresh.appToken, mount: 'transit', key: 'univarse-kek' });
    const dek = randomBytes(32);
    const context = wrapContext(randomUUID(), 1);
    expect(Buffer.compare(await provider.unwrap(await provider.wrap(dek, context), context), dek)).toBe(0);
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  it("[T2] the app's renewer keeps a short-period token alive past several periods; stopped, it dies", async () => {
    const d = shortLived(5);
    const token = loadVaultInit(d).appToken;
    const renewer = new VaultTokenRenewer({ addr, token, log: quiet, everyMs: 1500 });
    renewer.start();
    await pause(13_000);
    expect((await renewer.renewOnce()).kind).toBe('renewed');
    expect(vaultCli(docker, ['write', '-format=json', 'transit/encrypt/univarse-kek', `plaintext=${randomBytes(8).toString('base64')}`, `context=${Buffer.from('c').toString('base64')}`], app(d), undefined, TARGET).status).toBe(0);
    renewer.stop();
    await pause(7000);
    const after = await renewer.renewOnce();
    expect(after.kind).toBe('refused');
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  it("[T9] Vault's answer when sealed, pinned: every token command says sealed, never a dead token, and nothing is re-issued", () => {
    const { rootToken } = loadVaultInit(dir);
    const before = readFileSync(join(dir, 'vault-init.json'), 'utf8');
    expect(vaultCli(docker, ['operator', 'seal'], { VAULT_TOKEN: rootToken }, undefined, TARGET).status).toBe(0);
    try {
      const l = lookupToken(docker, rootToken, loadVaultInit(dir).appToken, TARGET);
      expect(l.ok).toBe(false);
      if (!l.ok) expect(l.failure).toEqual({ kind: 'sealed' });
      expect(classifyVaultFailure(vaultCli(docker, ['token', 'renew'], { VAULT_TOKEN: loadVaultInit(dir).appToken }, undefined, TARGET))).toEqual({ kind: 'sealed' });
      expect(() => ensureVault(docker, dir, TARGET)).toThrow(SEALED_LINE);
      expect(renewTokens(docker, dir, TARGET).lines[0]).toBe(`app token: not renewed: ${SEALED_LINE}`);
      expect(readFileSync(join(dir, 'vault-init.json'), 'utf8')).toBe(before);
    } finally {
      unseal(docker, dir, TARGET);
    }
    expect(vaultState(docker, TARGET)).toBe('ready');
  });
});
