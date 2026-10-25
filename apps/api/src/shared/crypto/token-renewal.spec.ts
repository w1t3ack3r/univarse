// Spec 0023 T2: only the real API and worker processes renew their token, and only with the vault provider.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import { AppModule } from '../../app.module.js';
import { WorkerModule } from '../../worker.module.js';
import { RENEW_VAULT_TOKEN, VaultTokenRenewal } from './token-renewal.js';

const vault = { KEY_PROVIDER: 'vault', VAULT_ADDR: 'https://vault:8200', VAULT_TOKEN: 'hvs.TOKENTOKENTOKEN' } as unknown as AppConfig;
const renewed = () => new Response(JSON.stringify({ auth: { lease_duration: 2764800 } }), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe('[0023 T2] VaultTokenRenewal', () => {
  it('the process asked for it, with the vault provider: renews at start, and stops at shutdown', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(renewed()));
    const r = new VaultTokenRenewal(vault, true);
    r.onApplicationBootstrap();
    await new Promise((res) => setTimeout(res, 0));
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe('https://vault:8200/v1/auth/token/renew-self');
    r.onApplicationShutdown();
  });

  it('not asked for (tests, the keys CLI): nothing is renewed', () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const r = new VaultTokenRenewal(vault, false);
    r.onApplicationBootstrap();
    expect(f).not.toHaveBeenCalled();
    r.onApplicationShutdown();
  });

  it('the local provider, or no Vault settings: nothing is renewed', () => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const config of [{ ...vault, KEY_PROVIDER: 'local' }, { ...vault, VAULT_TOKEN: undefined }] as unknown as AppConfig[]) {
      const r = new VaultTokenRenewal(config, true);
      r.onApplicationBootstrap();
      r.onApplicationShutdown();
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe('[0023 T2] the modules: off unless the process asks', () => {
  const flag = (m: { providers?: unknown[] }) =>
    (m.providers?.find((p) => (p as { provide?: unknown }).provide === RENEW_VAULT_TOKEN) as { useValue?: unknown } | undefined)?.useValue;

  it('WorkerModule and AppModule default to no renewal (tests, the keys CLI), and renew only when asked', () => {
    expect(flag(WorkerModule.forRoot(vault))).toBe(false);
    expect(flag(WorkerModule.forRoot(vault, { renewVaultToken: true }))).toBe(true);
    expect(flag(AppModule.forRoot(vault))).toBe(false);
    expect(flag(AppModule.forRoot(vault, { renewVaultToken: true }))).toBe(true);
  });
});
