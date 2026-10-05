import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PlatformClient } from '@univarse/db';
import { describe, expect, it, vi } from 'vitest';
import { encryptV1ForTests, encryptV2, legacyKeyringFromEnv, parseCipher, decryptWith } from './cipher.js';
import { FieldCrypto } from './field-crypto.js';
import { TenantKeyring } from './keyring.js';
import { KeyUnavailableError, LocalKeyProvider, VaultTransitProvider, keyProviderFrom, wrapContext } from './providers.js';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190b000-0000-7000-8000-00000000000b';
const kek = () => randomBytes(32).toString('base64');

/** In-memory stand-in for the platform table: enough of PlatformClient for the keyring. */
async function fakePlatform(provider: LocalKeyProvider, tenants: string[]) {
  const rows: { tenantId: string; version: number; status: string; wrappedDek: string | null }[] = [];
  for (const t of tenants) rows.push({ tenantId: t, version: 1, status: 'ACTIVE', wrappedDek: await provider.wrap(randomBytes(32), wrapContext(t, 1)) });
  const find = (w: { tenantId?: string; status?: string; version?: number }) =>
    rows.find((r) => (!w.tenantId || r.tenantId === w.tenantId) && (!w.status || r.status === w.status) && (!w.version || r.version === w.version)) ?? null;
  const platform = {
    tenantDataKey: {
      findFirst: vi.fn(({ where }: { where: { tenantId: string; status?: string } }) => Promise.resolve(find(where))),
      findUnique: vi.fn(({ where }: { where: { tenantId_version: { tenantId: string; version: number } } }) =>
        Promise.resolve(find(where.tenantId_version)),
      ),
    },
  } as unknown as PlatformClient;
  return { platform, rows };
}

describe('[E4] v2 cipher format', () => {
  it('round-trips and records the key version', () => {
    const dek = randomBytes(32);
    const stored = encryptV2(dek, 3, Buffer.from('secret'), 'aad');
    expect(stored).toMatch(/^v2:3:[\w-]+:[\w-]+:[\w-]+$/);
    expect(decryptWith(dek, parseCipher(stored), 'aad').toString()).toBe('secret');
  });

  it('binds the AAD and detects tampering', () => {
    const dek = randomBytes(32);
    const stored = encryptV2(dek, 1, Buffer.from('secret'), 'tenant-a:totp');
    expect(() => decryptWith(dek, parseCipher(stored), 'tenant-b:totp')).toThrow();
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptWith(dek, parseCipher(parts.join(':')), 'tenant-a:totp')).toThrow();
  });

  it('rejects unknown formats and malformed versions', () => {
    expect(() => parseCipher('v3:1:a:b:c')).toThrow(/Unsupported/);
    expect(() => parseCipher('v2:0:a:b:c')).toThrow(/Unsupported/);
    expect(() => parseCipher('v2:x:a:b:c')).toThrow(/Unsupported/);
  });
});

describe('[E2][E3] key providers', () => {
  it('a wrapped DEK unwraps only under its own tenant/version context', async () => {
    const p = new LocalKeyProvider('t', kek());
    const dek = randomBytes(32);
    const wrapped = await p.wrap(dek, wrapContext(A, 1));
    expect((await p.unwrap(wrapped, wrapContext(A, 1))).equals(dek)).toBe(true);
    await expect(p.unwrap(wrapped, wrapContext(B, 1))).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(p.unwrap(wrapped, wrapContext(A, 2))).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('the wrapped form never contains the DEK', async () => {
    const p = new LocalKeyProvider('t', kek());
    const dek = randomBytes(32);
    const wrapped = await p.wrap(dek, wrapContext(A, 1));
    expect(wrapped).not.toContain(dek.toString('base64'));
    expect(wrapped).not.toContain(dek.toString('base64url'));
  });

  it('refuses the local provider in production and requires Vault settings', () => {
    expect(() => keyProviderFrom({ KEY_PROVIDER: 'local', NODE_ENV: 'production', LOCAL_KEK: kek() })).toThrow(/not allowed in production/);
    expect(() => keyProviderFrom({ KEY_PROVIDER: 'vault' })).toThrow(/VAULT_ADDR and VAULT_TOKEN/);
    expect(keyProviderFrom({ KEY_PROVIDER: 'vault', VAULT_ADDR: 'http://127.0.0.1:8200', VAULT_TOKEN: 't' }).kekId).toBe('vault:transit/univarse-kek');
  });
});

/** A stand-in Transit endpoint that answers each request from a script of behaviours. */
async function fakeVault(script: ('hang' | 500 | 403 | 'ok')[]) {
  let calls = 0;
  const server = createServer((req, res) => {
    const step = script[Math.min(calls++, script.length - 1)]!;
    req.resume();
    if (step === 'hang') return; // never answers: the client's timeout fires
    if (step === 'ok') return res.end(JSON.stringify({ data: { ciphertext: 'vault:v1:abc' } }));
    res.statusCode = step;
    res.end('{"errors":[]}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const provider = new VaultTransitProvider({ addr: `http://127.0.0.1:${port}`, token: 't', mount: 'transit', key: 'k', timeoutMs: 200, retryDelayMs: 1 });
  return { provider, calls: () => calls, close: () => {
      server.closeAllConnections(); // drops the hung sockets
      return new Promise((r) => server.close(r));
    },
  };
}

describe('[E6] Vault transient failures', () => {
  it('retries a timeout or a 5xx once, then succeeds', async () => {
    for (const first of ['hang', 500] as const) {
      const v = await fakeVault([first, 'ok']);
      await expect(v.provider.wrap(randomBytes(32), wrapContext(A, 1))).resolves.toBe('vault:v1:abc');
      expect(v.calls()).toBe(2);
      await v.close();
    }
  });

  it('fails closed after the retry, with an operator-only detail', async () => {
    const v = await fakeVault(['hang', 'hang']);
    await expect(v.provider.wrap(randomBytes(32), wrapContext(A, 1))).rejects.toMatchObject({ reason: 'provider_unavailable', detail: 'TimeoutError' });
    expect(v.calls()).toBe(2);
    await v.close();
  });

  it('never retries a 4xx (a bad token or policy will not fix itself)', async () => {
    const v = await fakeVault([403, 'ok']);
    await expect(v.provider.wrap(randomBytes(32), wrapContext(A, 1))).rejects.toMatchObject({ reason: 'provider_unavailable', detail: 'HTTP 403' });
    expect(v.calls()).toBe(1);
    await v.close();
  });
});

describe('[E5][E6] keyring cache', () => {
  it('unwraps once per key, shares concurrent misses, and expires within the TTL', async () => {
    const provider = new LocalKeyProvider('t', kek());
    const unwrap = vi.spyOn(provider, 'unwrap');
    const { platform } = await fakePlatform(provider, [A]);
    let now = 0;
    const ring = new TenantKeyring(platform, provider, { ttlMs: 1000, now: () => now });
    const [k1, k2] = await Promise.all([ring.key(A, 1), ring.key(A, 1)]);
    expect(k1).toBe(k2);
    expect(unwrap).toHaveBeenCalledTimes(1);
    now = 1001;
    await ring.key(A, 1);
    expect(unwrap).toHaveBeenCalledTimes(2);
    expect(k1.every((b) => b === 0)).toBe(true); // the expired key was zeroed
  });

  it('caps the TTL at one hour and evicts beyond the size cap', async () => {
    const provider = new LocalKeyProvider('t', kek());
    const { platform } = await fakePlatform(provider, [A, B]);
    let now = 0;
    const ring = new TenantKeyring(platform, provider, { ttlMs: 10 * 60 * 60_000, maxEntries: 1, now: () => now });
    await ring.key(A, 1);
    await ring.key(B, 1);
    expect(ring.size).toBe(1);
    const unwrap = vi.spyOn(provider, 'unwrap');
    now = 60 * 60_000 + 1;
    await ring.key(B, 1);
    expect(unwrap).toHaveBeenCalledTimes(1); // a 10 h request was capped to 1 h
  });

  it('fails closed for destroyed keys and tenants without an active key', async () => {
    const provider = new LocalKeyProvider('t', kek());
    const { platform, rows } = await fakePlatform(provider, [A]);
    const ring = new TenantKeyring(platform, provider);
    await expect(ring.activeVersion(B)).rejects.toMatchObject({ reason: 'no_active_key' });
    rows[0]!.status = 'DESTROYED';
    rows[0]!.wrappedDek = null;
    await expect(ring.key(A, 1)).rejects.toMatchObject({ reason: 'key_destroyed' });
  });
});

describe('[E1][E4] field crypto', () => {
  it('writes v2 with the active version; one tenant cannot read another’s value even with its AAD', async () => {
    const provider = new LocalKeyProvider('t', kek());
    const { platform } = await fakePlatform(provider, [A, B]);
    const fc = new FieldCrypto(new TenantKeyring(platform, provider));
    const stored = await fc.encrypt(A, Buffer.from('totp-secret'), `${A}:u1:totp`);
    expect(stored.startsWith('v2:1:')).toBe(true);
    expect((await fc.decrypt(A, stored, `${A}:u1:totp`)).toString()).toBe('totp-secret');
    await expect(fc.decrypt(B, stored, `${A}:u1:totp`)).rejects.toThrow(); // wrong DEK, same AAD
  });

  it('[E9] still reads legacy v1 values with the old key (decrypt-only)', async () => {
    const provider = new LocalKeyProvider('t', kek());
    const { platform } = await fakePlatform(provider, [A]);
    const legacy = legacyKeyringFromEnv('dev-1', kek());
    const fc = new FieldCrypto(new TenantKeyring(platform, provider), legacy);
    const old = encryptV1ForTests(legacy, 'dev-1', Buffer.from('old-secret'), 'aad');
    expect(FieldCrypto.isLegacy(old)).toBe(true);
    expect((await fc.decrypt(A, old, 'aad')).toString()).toBe('old-secret');
    expect((await fc.encrypt(A, Buffer.from('new'), 'aad')).startsWith('v2:')).toBe(true); // new writes never v1
  });
});
