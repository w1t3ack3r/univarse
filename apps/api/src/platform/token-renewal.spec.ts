// Spec 0028 Q3: only the real platform API renews its token, and only with the vault provider.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from './platform-config.js';
import { ConsoleTokenRenewal } from './token-renewal.js';

const vault = { CONSOLE_KEY_PROVIDER: 'vault', VAULT_ADDR: 'https://vault:8200', CONSOLE_VAULT_TOKEN: 'hvs.CONSOLETOKENCONSOLE' } as unknown as PlatformConfig;
const renewed = () => new Response(JSON.stringify({ auth: { lease_duration: 2764800 } }), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe('[0028 Q3] ConsoleTokenRenewal', () => {
  it('asked for, with the vault provider: renews its own token at start, and stops at shutdown', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(renewed()));
    const r = new ConsoleTokenRenewal(vault, true);
    r.onApplicationBootstrap();
    await new Promise((res) => setTimeout(res, 0));
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe('https://vault:8200/v1/auth/token/renew-self');
    expect(new Headers(f.mock.calls[0]?.[1]?.headers).get('x-vault-token')).toBe('hvs.CONSOLETOKENCONSOLE');
    r.onApplicationShutdown();
  });

  it('not asked for (the integration tests), the local provider, or no token: nothing is renewed', () => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const [config, enabled] of [
      [vault, false],
      [{ ...vault, CONSOLE_KEY_PROVIDER: 'local' }, true],
      [{ ...vault, CONSOLE_VAULT_TOKEN: undefined }, true],
    ] as [PlatformConfig, boolean][]) {
      const r = new ConsoleTokenRenewal(config, enabled);
      r.onApplicationBootstrap();
      r.onApplicationShutdown();
    }
    expect(f).not.toHaveBeenCalled();
  });
});
