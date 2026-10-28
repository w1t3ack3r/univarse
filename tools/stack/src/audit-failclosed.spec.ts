// Spec 0019 C4/LS8: Vault's audit device fails closed, shown on a THROWAWAY Vault, never the stack's. It is the stack's
// pinned image in server mode (file storage, initialised and unsealed), set up by the stack's own code (vault.ts:
// the audit device, Transit, the derived KEK, the app policy and token), and reached by the app's own provider code
// (`keyProviderFrom`, as the API builds it). Its listener is published on 127.0.0.1 for this test only, in plain HTTP:
// TLS is C2's, checked on the stack. Needs Docker.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyUnavailableError, keyProviderFrom, wrapContext, type KeyProvider } from '../../../packages/crypto/src/providers.js';
import { THIRD_PARTY } from './config.js';
import { docker } from './docker.js';
import { auditProblems } from './smoke.js';
import { AUDIT_LOG, initialise, loadVaultInit, vaultCli, vaultState, type VaultTarget } from './vault.js';

const NAME = `uv-audit-failclosed-${randomBytes(4).toString('hex')}`;
const TARGET: VaultTarget = { container: NAME, tls: false };
const HCL = 'storage "file" { path = "/vault/file" }\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_disable = true\n}\ndisable_mlock = true\nui = false';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let provider: KeyProvider;

/** Vault reopens its audit file on SIGHUP: the moment an unwritable log takes effect (or a restored one). */
async function reload(): Promise<void> {
  docker(['exec', NAME, 'kill', '-HUP', '1']);
  await pause(1500);
}
const chmodLog = (mode: string) => docker(['exec', NAME, 'chmod', mode, AUDIT_LOG]); // as the vault user, its owner

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uv-audit-'));
  docker(['volume', 'create', NAME]);
  docker([
    'run', '-d', '--name', NAME, '--user', '100:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/vault/file:uid=100,gid=1000', '--tmpfs', '/tmp:uid=100,gid=1000', '-v', `${NAME}:/vault/logs`, '-p', '127.0.0.1::8200',
    '--entrypoint', 'sh', THIRD_PARTY.vault, '-c', `printf '%s\\n' '${HCL}' > /tmp/v.hcl && exec vault server -config=/tmp/v.hcl`,
  ]);
  for (let i = 0; i < 40 && vaultState(docker, TARGET) !== 'uninitialised'; i++) await pause(500);
  const init = initialise(docker, dir, TARGET);
  const port = docker(['port', NAME, '8200/tcp']).stdout.trim().split('\n')[0]?.split(':').at(-1) ?? '';
  provider = keyProviderFrom({ KEY_PROVIDER: 'vault', NODE_ENV: 'test', VAULT_ADDR: `http://127.0.0.1:${port}`, VAULT_TOKEN: init.appToken });
}, 120_000);

afterAll(() => {
  docker(['rm', '-f', '-v', NAME], { allowFail: true });
  docker(['volume', 'rm', NAME], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('[LS8] the audit device (C3, C4), on a throwaway Vault', () => {
  it("[LS8] the app's own DEK wrap and unwrap are in the audit log as HMACs, never in clear", async () => {
    const dek = randomBytes(32);
    const context = wrapContext(randomUUID(), 1);
    expect(Buffer.compare(await provider.unwrap(await provider.wrap(dek, context), context), dek)).toBe(0);
    const root = { VAULT_TOKEN: loadVaultInit(dir).rootToken };
    const hmac = (input: string) => (JSON.parse(vaultCli(docker, ['write', '-format=json', 'sys/audit-hash/file', `input=${input}`], root, undefined, TARGET).stdout) as { data: { hash: string } }).data.hash;
    const plain = dek.toString('base64');
    const ctx = Buffer.from(context).toString('base64');
    const log = docker(['exec', NAME, 'cat', AUDIT_LOG]).stdout;
    expect(auditProblems(log, { plain, context: ctx, plainHmac: hmac(plain), contextHmac: hmac(ctx) })).toEqual([]);
    expect(log).not.toContain(context); // nor the context's own text
  });

  it('[LS8] with the audit log unwritable, Vault refuses and the provider fails closed (provider_unavailable); restored, it serves again', async () => {
    const context = wrapContext(randomUUID(), 1);
    const wrapped = await provider.wrap(randomBytes(32), context);
    chmodLog('000');
    try {
      await reload();
      for (const attempt of [() => provider.wrap(randomBytes(32), context), () => provider.unwrap(wrapped, context)]) {
        const err = await attempt().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(KeyUnavailableError);
        expect((err as KeyUnavailableError).reason).toBe('provider_unavailable');
      }
    } finally {
      chmodLog('600');
      await reload();
    }
    expect((await provider.unwrap(wrapped, context)).length).toBe(32);
  });
});
