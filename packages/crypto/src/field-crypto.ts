// The one call site for field encryption (spec 0006 design notes). Callers never see keys.
// Writes: v2 with the tenant's active DEK. Reads: v2 by version; v1 via the legacy key (E9, read-only).
import { decryptWith, encryptV2, parseCipher, type LegacyKeyring } from './cipher.js';
import type { TenantKeyring } from './keyring.js';

export class FieldCrypto {
  constructor(
    private readonly keyring: TenantKeyring,
    private readonly legacy: LegacyKeyring = { keys: new Map() },
  ) {}

  async encrypt(tenantId: string, plaintext: Uint8Array, aad: string): Promise<string> {
    const version = await this.keyring.activeVersion(tenantId);
    const dek = await this.keyring.key(tenantId, version);
    return encryptV2(dek, version, plaintext, aad);
  }

  async decrypt(tenantId: string, stored: string, aad: string): Promise<Buffer> {
    const parsed = parseCipher(stored);
    if (parsed.format === 'v2') return decryptWith(await this.keyring.key(tenantId, Number(parsed.key)), parsed, aad);
    const legacy = this.legacy.keys.get(parsed.key);
    if (!legacy) throw new Error(`Unknown legacy encryption key id ${parsed.key}`);
    return decryptWith(legacy, parsed, aad);
  }

  /** True when a stored value still needs the v1 → v2 migration (E9). */
  static isLegacy(stored: string): boolean {
    return stored.startsWith('v1:');
  }
}
