// Spec 0020 B-4: the tokens the env files carry, so a deploy that stops early never blanks a working one.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envTokens } from './vault.js';

const withInit = (appToken: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
  writeFileSync(join(dir, 'vault-init.json'), JSON.stringify({ unsealKey: 'u', rootToken: 'r', appToken }));
  return dir;
};

describe('envTokens', () => {
  it("keeps vault-init.json's app token even before the deploy's Vault step", () => {
    // A blank one here rewrote keys.env with VAULT_TOKEN= (a refused deploy did), and the keys job failed at startup.
    expect(envTokens(false, withInit('app-token-value')).appToken).toBe('app-token-value');
    expect(envTokens(true, withInit('app-token-value')).appToken).toBe('app-token-value');
  });

  it('is blank only before Vault was initialised, and then required at the Vault step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
    expect(envTokens(false, dir).appToken).toBe('');
    expect(() => envTokens(true, dir)).toThrow(/stack:vault init/);
  });
});
