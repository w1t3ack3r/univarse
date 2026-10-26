// Proof fixture (spec 0024 G8), never shipped: a GCM decipher that doesn't state its tag length, so a truncated tag
// would authenticate. Semgrep must block on it (gcm-no-tag-length, ERROR).
import { createDecipheriv } from 'node:crypto';

export function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
