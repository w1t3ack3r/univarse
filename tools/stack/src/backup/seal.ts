// Spec 0020 D5, B-5: every artifact of a backup set is sealed to the owner's backup public key (X25519). The private
// key lives only with the owner, offline, encrypted with a passphrase; nothing here ever writes it into the stack
// directory, the repository, a ledger destination or the backup destination.
//
// A sealed file is a fixed header, then chunks:
//   header  = MAGIC (8) | recipient fingerprint (32) | ephemeral X25519 public key (32) | HKDF salt (32)
//             | wrap IV (12) | the content key wrapped with AES-256-GCM (32 + 16 tag)
//   chunk i = AES-256-GCM(content key, nonce = i as 96-bit big-endian, aad = SHA-256(header) | final (u8))
//             of up to CHUNK bytes of plaintext, then its 16-byte tag.
// Every chunk but the last is exactly CHUNK bytes; the last (possibly empty) has final = 1. So a truncated file (its
// last remaining chunk has final = 0), reordered chunks (the nonce is the position), spliced chunks (the content key
// and header hash differ), and an edited
// header (the wrap's AAD, and every chunk's) all fail to decrypt.
//
// The content key is random per file and wrapped, not derived straight from the ECDH secret, so rotating the backup key
// re-wraps headers without re-encrypting sets (B-5).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, type KeyObject } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const MAGIC = Buffer.from('UVSEAL01', 'ascii');
export const CHUNK = 64 * 1024;
const TAG = 16;
const KEY = 32;
const HEADER = MAGIC.length + 32 + 32 + 32 + 12 + KEY + TAG;
const INFO = Buffer.from('univarse-backup-seal-v1', 'ascii');
// X25519's SubjectPublicKeyInfo DER prefix: the raw 32-byte key follows it.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export class SealError extends Error {}

/** The raw 32 bytes of an X25519 public key. */
export function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ type: 'spki', format: 'der' });
  if (der.length !== SPKI_PREFIX.length + 32 || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) throw new SealError('not an X25519 public key');
  return der.subarray(SPKI_PREFIX.length);
}

const publicFromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

/** The key's fingerprint: SHA-256 of its raw bytes, as the manifest and the index name it. */
export const fingerprint = (pub: KeyObject): Buffer => createHash('sha256').update(rawPublicKey(pub)).digest();

function wrapKey(shared: Buffer, salt: Buffer, eph: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.concat([INFO, eph, recipient]), KEY));
}

const nonce = (i: bigint) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(i, 4);
  return n;
};
const aad = (headerHash: Buffer, final: boolean) => Buffer.concat([headerHash, Buffer.from([final ? 1 : 0])]);

/** A new header for one file, and its content key. */
function newHeader(recipient: KeyObject): { header: Buffer; contentKey: Buffer } {
  const recipientRaw = rawPublicKey(recipient);
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const ephRaw = rawPublicKey(publicKey);
  const salt = randomBytes(32);
  const kek = wrapKey(diffieHellman({ privateKey, publicKey: recipient }), salt, ephRaw, recipientRaw);
  const contentKey = randomBytes(KEY);
  const iv = randomBytes(12);
  const fp = createHash('sha256').update(recipientRaw).digest();
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.concat([MAGIC, fp, ephRaw, salt]));
  const wrapped = Buffer.concat([c.update(contentKey), c.final(), c.getAuthTag()]);
  return { header: Buffer.concat([MAGIC, fp, ephRaw, salt, iv, wrapped]), contentKey };
}

/** The content key from a header, with the owner's private key; refuses a header for another key, or an edited one. */
function openHeader(header: Buffer, recipient: KeyObject): Buffer {
  if (header.length !== HEADER || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError('not a sealed file (bad magic)');
  let o = MAGIC.length;
  const take = (n: number) => header.subarray(o, (o += n));
  const fp = take(32);
  const ephRaw = take(32);
  const salt = take(32);
  const iv = take(12);
  const wrapped = take(KEY);
  const tag = take(TAG);
  const pub = createPublicKey(recipient);
  if (!fp.equals(fingerprint(pub))) throw new SealError('sealed to another backup key');
  const kek = wrapKey(diffieHellman({ privateKey: recipient, publicKey: publicFromRaw(Buffer.from(ephRaw)) }), salt, ephRaw, rawPublicKey(pub));
  const d = createDecipheriv('aes-256-gcm', kek, iv);
  d.setAAD(Buffer.concat([MAGIC, fp, ephRaw, salt]));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(wrapped), d.final()]);
  } catch {
    throw new SealError('the header does not authenticate');
  }
}

/** Seals a stream: the header first, then each full chunk as it fills, and the final chunk at the end. */
export function sealStream(recipient: KeyObject): Transform {
  const { header, contentKey } = newHeader(recipient);
  const headerHash = createHash('sha256').update(header).digest();
  let i = 0n;
  let pending: Buffer = Buffer.alloc(0);
  let started = false;
  const chunk = (plain: Buffer, final: boolean) => {
    const c = createCipheriv('aes-256-gcm', contentKey, nonce(i));
    c.setAAD(aad(headerHash, final));
    i += 1n;
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  return new Transform({
    transform(data: Buffer, _enc, done: TransformCallback) {
      if (!started) {
        this.push(header);
        started = true;
      }
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      // Keep at least one byte back, so the last full chunk is written as final when nothing follows it.
      while (pending.length > CHUNK) {
        this.push(chunk(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done: TransformCallback) {
      if (!started) this.push(header);
      this.push(chunk(pending, true));
      contentKey.fill(0);
      done();
    },
  });
}

/** Unseals a stream: fails on a wrong key, an edited header, a reordered, altered or truncated chunk, or trailing data. */
export function unsealStream(recipient: KeyObject): Transform {
  let header: Buffer | null = null;
  let contentKey: Buffer | null = null;
  let headerHash: Buffer | null = null;
  let i = 0n;
  let pending: Buffer = Buffer.alloc(0);
  const open = (sealed: Buffer, final: boolean) => {
    const d = createDecipheriv('aes-256-gcm', contentKey as Buffer, nonce(i));
    d.setAAD(aad(headerHash as Buffer, final));
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    i += 1n;
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
    } catch {
      throw new SealError(`chunk ${String(i - 1n)} does not authenticate (altered, reordered or truncated)`);
    }
  };
  return new Transform({
    transform(data: Buffer, _enc, done: TransformCallback) {
      try {
        pending = pending.length ? Buffer.concat([pending, data]) : data;
        if (!header) {
          if (pending.length < HEADER) {
            done();
            return;
          }
          header = pending.subarray(0, HEADER);
          contentKey = openHeader(header, recipient);
          headerHash = createHash('sha256').update(header).digest();
          pending = pending.subarray(HEADER);
        }
        // A full chunk is known not to be the last only once more bytes follow it.
        while (pending.length > CHUNK + TAG) {
          this.push(open(pending.subarray(0, CHUNK + TAG), false));
          pending = pending.subarray(CHUNK + TAG);
        }
        done();
      } catch (e) {
        done(e as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!header) throw new SealError('not a sealed file (shorter than its header)');
        if (pending.length < TAG) throw new SealError('truncated: no final chunk');
        this.push(open(pending, true));
        contentKey?.fill(0);
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
}

async function through(t: Transform, data: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  t.on('data', (b: Buffer) => out.push(b));
  const done = new Promise<void>((res, rej) => {
    t.on('end', res);
    t.on('error', rej);
  });
  t.end(data);
  await done;
  return Buffer.concat(out);
}

export const seal = (data: Buffer, recipient: KeyObject) => through(sealStream(recipient), data);
export const unseal = (data: Buffer, recipient: KeyObject) => through(unsealStream(recipient), data);

// ── The key files ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The private key file: its PKCS#8 bytes encrypted with AES-256-GCM under a key derived from the owner's passphrase
 * with scrypt (N = 2^17, r = 8, p = 1). Not Node's encrypted PEM: that uses PBKDF2 with OpenSSL's 2048 iterations.
 */
export interface PrivateKeyFile {
  readonly format: 'univarse-backup-key-v1';
  readonly fingerprint: string;
  readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number; readonly salt: string };
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
export const MIN_PASSPHRASE = 16;
const passKey = (passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  scryptSync(passphrase.normalize('NFC'), salt, KEY, { ...k, maxmem: 256 * 1024 * 1024 });

/** A new key pair: the public key as PEM (for the repository), the private key file (for the owner, offline). */
export function generateBackupKey(passphrase: string, kdf: { N: number; r: number; p: number } = SCRYPT): { publicPem: string; privateFile: PrivateKeyFile; fingerprint: string } {
  if (passphrase.length < MIN_PASSPHRASE) throw new SealError(`the passphrase must be at least ${String(MIN_PASSPHRASE)} characters`);
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', passKey(passphrase, salt, kdf), iv);
  const fp = fingerprint(publicKey).toString('hex');
  c.setAAD(Buffer.from(fp, 'ascii'));
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const ciphertext = Buffer.concat([c.update(der), c.final()]);
  der.fill(0);
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: fp,
    privateFile: {
      format: 'univarse-backup-key-v1',
      fingerprint: fp,
      kdf: { name: 'scrypt', ...kdf, salt: salt.toString('base64') },
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
    },
  };
}

/** The private key from its file and the passphrase; a wrong passphrase or an edited file fails, naming neither. */
export function loadPrivateKey(file: Readonly<Omit<PrivateKeyFile, 'format' | 'kdf'>> & { readonly format: string; readonly kdf: Readonly<Omit<PrivateKeyFile['kdf'], 'name'>> & { readonly name: string } }, passphrase: string): KeyObject {
  if (file.format !== 'univarse-backup-key-v1' || file.kdf.name !== 'scrypt') throw new SealError('not a UniVarse backup key file');
  const d = createDecipheriv('aes-256-gcm', passKey(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf), Buffer.from(file.iv, 'base64'));
  d.setAAD(Buffer.from(file.fingerprint, 'ascii'));
  d.setAuthTag(Buffer.from(file.tag, 'base64'));
  let der: Buffer;
  try {
    der = Buffer.concat([d.update(Buffer.from(file.ciphertext, 'base64')), d.final()]);
  } catch {
    throw new SealError('the backup key does not open: wrong passphrase, or the file was changed');
  }
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  der.fill(0);
  if (fingerprint(createPublicKey(key)).toString('hex') !== file.fingerprint) throw new SealError('the backup key file names another key');
  return key;
}

export const loadPublicKey = (pem: string): KeyObject => {
  const k = createPublicKey(pem);
  rawPublicKey(k); // X25519 only
  return k;
};
