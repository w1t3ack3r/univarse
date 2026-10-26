// Spec 0020 BK3 and D5: a set's artifacts don't decrypt without the private key, and a truncated, reordered, spliced
// or edited artifact fails to decrypt.
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Transform } from 'node:stream';
import { CHUNK, generateBackupKey, loadPrivateKey, loadPublicKey, MAGIC, seal, SealError, sealStream, unseal, unsealStream } from './seal.js';

const HEADER = 8 + 32 + 32 + 32 + 12 + 32 + 16;
const SEALED_CHUNK = CHUNK + 16;
// Fast parameters for tests only: the real default is N = 2^17.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { pub: publicKey, priv: privateKey };
}

describe('seal and unseal', () => {
  const { pub, priv } = pair();

  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 17]) {
    it(`round-trips ${String(size)} bytes`, async () => {
      const data = randomBytes(size);
      const sealed = await seal(data, pub);
      expect(sealed.subarray(0, 8).equals(MAGIC)).toBe(true);
      // Every chunk but the last is full; an exact multiple ends with a full final chunk, and empty data has one.
      const chunks = Math.max(1, Math.ceil(size / CHUNK));
      expect(sealed.length).toBe(HEADER + size + chunks * 16);
      expect((await unseal(sealed, priv)).equals(data)).toBe(true);
    });
  }

  it('gives the same result when the stream arrives in uneven pieces', async () => {
    const pieces = async (t: Transform, data: Buffer, sizes: readonly number[]) => {
      const out: Buffer[] = [];
      t.on('data', (b: Buffer) => out.push(b));
      const done = new Promise<void>((res, rej) => t.on('end', res).on('error', rej));
      let at = 0;
      for (let k = 0; at < data.length; k++) {
        const n = sizes[k % sizes.length] ?? 1;
        t.write(data.subarray(at, at + n));
        at += n;
      }
      t.end();
      await done;
      return Buffer.concat(out);
    };
    const data = randomBytes(3 * CHUNK + 333);
    const sealed = await pieces(sealStream(pub), data, [1, 7000, CHUNK, 65_537, 3]);
    expect((await unseal(sealed, priv)).equals(data)).toBe(true);
    expect((await pieces(unsealStream(priv), sealed, [5, 100, CHUNK + 16, 1, 99_999])).equals(data)).toBe(true);
  });

  it('does not hold the plaintext in clear', async () => {
    const marker = Buffer.from('a-secret-value-that-must-not-appear-0123456789');
    const sealed = await seal(Buffer.concat([marker, marker, marker]), pub);
    expect(sealed.includes(marker)).toBe(false);
  });

  it('two seals of the same data differ (a fresh key per file)', async () => {
    const data = randomBytes(100);
    expect((await seal(data, pub)).equals(await seal(data, pub))).toBe(false);
  });

  it('refuses another private key', async () => {
    const sealed = await seal(randomBytes(10), pub);
    await expect(unseal(sealed, pair().priv)).rejects.toThrow(/another backup key/);
  });

  it('refuses an edited header', async () => {
    const sealed = await seal(randomBytes(10), pub);
    for (const at of [8 + 32 + 1, 8 + 64 + 1, 8 + 96 + 1, HEADER - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = (bad[at] ?? 0) ^ 1;
      await expect(unseal(bad, priv)).rejects.toThrow(SealError);
    }
  });

  it('refuses a file truncated at a chunk boundary', async () => {
    const sealed = await seal(randomBytes(3 * CHUNK + 5), pub);
    await expect(unseal(sealed.subarray(0, HEADER + 2 * SEALED_CHUNK), priv)).rejects.toThrow(/does not authenticate/);
  });

  it('refuses a file truncated inside a chunk, or to its header', async () => {
    const sealed = await seal(randomBytes(CHUNK + 5), pub);
    await expect(unseal(sealed.subarray(0, sealed.length - 1), priv)).rejects.toThrow(SealError);
    await expect(unseal(sealed.subarray(0, HEADER), priv)).rejects.toThrow(/truncated/);
    await expect(unseal(sealed.subarray(0, HEADER - 1), priv)).rejects.toThrow(/shorter than its header/);
  });

  it('refuses reordered chunks', async () => {
    const sealed = await seal(randomBytes(3 * CHUNK + 5), pub);
    const c = (i: number) => sealed.subarray(HEADER + i * SEALED_CHUNK, HEADER + (i + 1) * SEALED_CHUNK);
    const swapped = Buffer.concat([sealed.subarray(0, HEADER), c(1), c(0), sealed.subarray(HEADER + 2 * SEALED_CHUNK)]);
    await expect(unseal(swapped, priv)).rejects.toThrow(/chunk 0 does not authenticate/);
  });

  it('refuses a chunk spliced in from another file sealed to the same key', async () => {
    const a = await seal(randomBytes(2 * CHUNK + 5), pub);
    const b = await seal(randomBytes(2 * CHUNK + 5), pub);
    const spliced = Buffer.concat([a.subarray(0, HEADER + SEALED_CHUNK), b.subarray(HEADER + SEALED_CHUNK)]);
    await expect(unseal(spliced, priv)).rejects.toThrow(/chunk 1 does not authenticate/);
  });

  it('refuses trailing data, and an altered byte anywhere in a chunk', async () => {
    const sealed = await seal(randomBytes(CHUNK + 5), pub);
    await expect(unseal(Buffer.concat([sealed, Buffer.from([0])]), priv)).rejects.toThrow(SealError);
    const bad = Buffer.from(sealed);
    bad[HEADER + 10] = (bad[HEADER + 10] ?? 0) ^ 0x80;
    await expect(unseal(bad, priv)).rejects.toThrow(/chunk 0/);
  });

  it('refuses a non-X25519 public key', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => loadPublicKey(ed)).toThrow(SealError);
  });
});

describe('the backup key files', () => {
  it('round-trips through the passphrase, and the public PEM matches', async () => {
    const k = generateBackupKey(PASS, FAST);
    const priv = loadPrivateKey(k.privateFile, PASS);
    const pub = loadPublicKey(k.publicPem);
    expect(createPublicKey(priv).export({ type: 'spki', format: 'pem' })).toBe(k.publicPem);
    const data = randomBytes(1000);
    expect((await unseal(await seal(data, pub), priv)).equals(data)).toBe(true);
  });

  it('a wrong passphrase, or an edited file, fails without saying which', () => {
    const k = generateBackupKey(PASS, FAST);
    expect(() => loadPrivateKey(k.privateFile, `${PASS}!`)).toThrow(/wrong passphrase, or the file was changed/);
    const ct = Buffer.from(k.privateFile.ciphertext, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => loadPrivateKey({ ...k.privateFile, ciphertext: ct.toString('base64') }, PASS)).toThrow(SealError);
    expect(() => loadPrivateKey({ ...k.privateFile, fingerprint: '00'.repeat(32) }, PASS)).toThrow(SealError);
  });

  it('[spec 0024] a private file with a truncated tag, even a genuine one, fails the same way, as a SealError', () => {
    const k = generateBackupKey(PASS, FAST);
    const short = Buffer.from(k.privateFile.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => loadPrivateKey({ ...k.privateFile, tag: short }, PASS)).toThrow(SealError);
    expect(() => loadPrivateKey({ ...k.privateFile, tag: short }, PASS)).toThrow(/wrong passphrase, or the file was changed/);
  });

  it('the private file holds no key material in clear', () => {
    const k = generateBackupKey(PASS, FAST);
    const der = loadPrivateKey(k.privateFile, PASS).export({ type: 'pkcs8', format: 'der' });
    const raw = der.subarray(der.length - 32);
    const text = JSON.stringify(k.privateFile);
    expect(text.includes(raw.toString('base64'))).toBe(false);
    expect(text.includes(raw.toString('hex'))).toBe(false);
    expect(Buffer.from(k.privateFile.ciphertext, 'base64').includes(raw)).toBe(false);
  });

  it('the default KDF is scrypt at N = 2^17', () => {
    const k = generateBackupKey(PASS);
    expect(k.privateFile.kdf).toMatchObject({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
  });

  it('refuses a short passphrase', () => {
    expect(() => generateBackupKey('short', FAST)).toThrow(/at least 16/);
  });
});
