// KEK providers (spec 0006 E3, ADR-023). The KEK never leaves the provider; callers see only wrapped
// strings. The wrap context binds a wrapped DEK to its tenant and version (E2).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Raised when a DEK can't be wrapped or unwrapped (fail closed, E6). `detail` is for operators only:
 * an HTTP status or a network error name, never a token, key, ciphertext or Vault response body.
 */
export class KeyUnavailableError extends Error {
  constructor(
    readonly reason: 'provider_unavailable' | 'unwrap_failed' | 'no_active_key' | 'key_destroyed',
    readonly detail?: string,
  ) {
    super(`Encryption key unavailable (${reason}${detail ? `: ${detail}` : ''})`);
    this.name = 'KeyUnavailableError';
  }
}

export interface KeyProvider {
  /** Stable id of the KEK this provider wraps with, stored beside each wrapped DEK. */
  readonly kekId: string;
  wrap(dek: Uint8Array, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

/** Internal: a failure worth one retry. Never escapes the provider. */
class TransientVaultError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export const wrapContext = (tenantId: string, version: number) => `univarse:dek:${tenantId}:${version}`;

/**
 * Vault / OpenBao Transit (ADR-023). The key is `aes256-gcm96` with `derived=true`, so the context
 * selects a per-(tenant, version) derived key: a wrapped DEK moved elsewhere won't unwrap. The app's
 * token may only call encrypt/decrypt on this key.
 */
export class VaultTransitProvider implements KeyProvider {
  readonly kekId: string;

  constructor(
    private readonly opts: {
      addr: string;
      token: string;
      mount: string;
      key: string;
      timeoutMs?: number;
      attempts?: number;
      retryDelayMs?: number;
    },
  ) {
    if (!/^[a-z0-9_-]{1,64}$/.test(opts.mount) || !/^[a-z0-9_-]{1,64}$/.test(opts.key)) {
      throw new Error('Invalid Vault transit mount or key name');
    }
    this.kekId = `vault:${opts.mount}/${opts.key}`;
  }

  /**
   * Transit encrypt/decrypt have no side effects, so a transient failure (timeout, network error,
   * 5xx) is retried once after a short pause; a 4xx is never retried. If both attempts fail we still
   * fail closed (E6). Observed: a cold call under load can pass 3 s on a busy host.
   */
  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    const attempts = this.opts.attempts ?? 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(op, body);
      } catch (err) {
        if (!(err instanceof TransientVaultError) || attempt >= attempts) {
          throw err instanceof TransientVaultError ? new KeyUnavailableError('provider_unavailable', err.detail) : err;
        }
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 100));
      }
    }
  }

  private async once(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.addr.replace(/\/$/, '')}/v1/${this.opts.mount}/${op}/${this.opts.key}`, {
        method: 'POST',
        headers: { 'x-vault-token': this.opts.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      throw new TransientVaultError(e.cause?.code ?? e.name ?? 'network');
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status >= 500) throw new TransientVaultError(`HTTP ${res.status}`);
      // 400 on decrypt = wrong context / tampered ciphertext; other 4xx = misconfiguration (token, policy).
      throw new KeyUnavailableError(op === 'decrypt' && res.status === 400 ? 'unwrap_failed' : 'provider_unavailable', `HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Record<string, string> };
    if (!json.data) throw new KeyUnavailableError('provider_unavailable', 'no data');
    return json.data;
  }

  async wrap(dek: Uint8Array, context: string): Promise<string> {
    const data = await this.call('encrypt', {
      plaintext: Buffer.from(dek).toString('base64'),
      context: Buffer.from(context, 'utf8').toString('base64'),
    });
    if (!data.ciphertext?.startsWith('vault:')) throw new KeyUnavailableError('provider_unavailable');
    return data.ciphertext;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    const data = await this.call('decrypt', {
      ciphertext: wrapped,
      context: Buffer.from(context, 'utf8').toString('base64'),
    });
    const dek = Buffer.from(data.plaintext ?? '', 'base64');
    if (dek.length !== 32) throw new KeyUnavailableError('unwrap_failed');
    return dek;
  }
}

/**
 * In-process KEK for unit tests only (spec 0006 design notes). Same contract as Transit: the context
 * is bound as AAD. Refused in production by the caller (config).
 */
export class LocalKeyProvider implements KeyProvider {
  readonly kekId: string;
  private readonly kek: Buffer;

  constructor(id: string, base64Kek: string) {
    this.kek = Buffer.from(base64Kek, 'base64');
    if (this.kek.length !== 32) throw new Error('Local KEK must be 32 bytes (base64)');
    this.kekId = `local:${id}`;
  }

  wrap(dek: Uint8Array, context: string): Promise<string> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.kek, iv);
    c.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Promise.resolve(['local', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join(':'));
  }

  unwrap(wrapped: string, context: string): Promise<Buffer> {
    try {
      const [tag0, iv, ct, tag] = wrapped.split(':');
      if (tag0 !== 'local' || !iv || !ct || !tag) throw new Error('format');
      const d = createDecipheriv('aes-256-gcm', this.kek, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(context, 'utf8'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Promise.resolve(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]));
    } catch {
      return Promise.reject(new KeyUnavailableError('unwrap_failed'));
    }
  }
}

export interface KeyProviderConfig {
  readonly KEY_PROVIDER: 'vault' | 'local';
  readonly NODE_ENV?: string | undefined;
  readonly VAULT_ADDR?: string | undefined;
  readonly VAULT_TOKEN?: string | undefined;
  readonly VAULT_TRANSIT_MOUNT?: string | undefined;
  readonly VAULT_TRANSIT_KEY?: string | undefined;
  readonly LOCAL_KEK?: string | undefined;
}

/** One factory for the API, worker, seed and tests. `local` is refused in production. */
export function keyProviderFrom(c: KeyProviderConfig): KeyProvider {
  if (c.KEY_PROVIDER === 'local') {
    if (c.NODE_ENV === 'production') throw new Error('KEY_PROVIDER=local is not allowed in production (spec 0006)');
    if (!c.LOCAL_KEK) throw new Error('LOCAL_KEK is required for KEY_PROVIDER=local');
    return new LocalKeyProvider('test', c.LOCAL_KEK);
  }
  if (!c.VAULT_ADDR || !c.VAULT_TOKEN) throw new Error('VAULT_ADDR and VAULT_TOKEN are required for KEY_PROVIDER=vault');
  return new VaultTransitProvider({
    addr: c.VAULT_ADDR,
    token: c.VAULT_TOKEN,
    mount: c.VAULT_TRANSIT_MOUNT ?? 'transit',
    key: c.VAULT_TRANSIT_KEY ?? 'univarse-kek',
  });
}
