// Spec 0034 Q7: the provisioning key, configured the same way in its two processes. The platform API seals invites
// with it; the worker opens them. On the stack each process has its own token, whose Vault policy allows only its
// half (encrypt, or decrypt). `local` is for development and tests: one shared key, refused in production.
import { keyProviderFrom, PROVISIONING_KEK, vaultAddrProblem, type KeyProvider } from '@univarse/crypto';

export interface ProvisioningKeySettings {
  readonly NODE_ENV?: string | undefined;
  readonly VAULT_ADDR?: string | undefined;
  readonly VAULT_TRANSIT_MOUNT?: string | undefined;
  readonly PROVISIONING_KEY_PROVIDER?: 'vault' | 'local' | undefined;
  readonly PROVISIONING_VAULT_TOKEN?: string | undefined;
  readonly PROVISIONING_LOCAL_KEK?: string | undefined;
}

/** Why the settings are refused, by name only; none when provisioning simply isn't set up. */
export function provisioningKeySettingsProblems(c: ProvisioningKeySettings): string[] {
  if (!c.PROVISIONING_KEY_PROVIDER) return [];
  if (c.PROVISIONING_KEY_PROVIDER === 'local') {
    if (c.NODE_ENV === 'production') return ['PROVISIONING_KEY_PROVIDER: local is refused in production (spec 0034 Q7)'];
    return c.PROVISIONING_LOCAL_KEK ? [] : ['PROVISIONING_LOCAL_KEK: required for PROVISIONING_KEY_PROVIDER=local'];
  }
  const problems: string[] = [];
  if (!c.VAULT_ADDR) problems.push('VAULT_ADDR: required for the provisioning key (spec 0034 Q7)');
  if (!c.PROVISIONING_VAULT_TOKEN) problems.push('PROVISIONING_VAULT_TOKEN: required for the provisioning key (spec 0034 Q7)');
  const plain = vaultAddrProblem({ KEY_PROVIDER: 'vault', NODE_ENV: c.NODE_ENV, VAULT_ADDR: c.VAULT_ADDR });
  if (c.VAULT_ADDR && plain) problems.push(`VAULT_ADDR: ${plain}`);
  return problems;
}

/** The provider, or null when provisioning isn't set up in this process. */
export function provisioningKeyFrom(c: ProvisioningKeySettings): KeyProvider | null {
  if (!c.PROVISIONING_KEY_PROVIDER) return null;
  return keyProviderFrom({
    KEY_PROVIDER: c.PROVISIONING_KEY_PROVIDER,
    NODE_ENV: c.NODE_ENV,
    VAULT_ADDR: c.VAULT_ADDR,
    VAULT_TOKEN: c.PROVISIONING_VAULT_TOKEN,
    VAULT_TRANSIT_MOUNT: c.VAULT_TRANSIT_MOUNT,
    VAULT_TRANSIT_KEY: PROVISIONING_KEK,
    LOCAL_KEK: c.PROVISIONING_LOCAL_KEK,
  });
}
