// Adds missing local-dev secrets (not DB — see `pnpm db:setup`) to the git-ignored root .env.
// Existing values are never overwritten.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../.env', import.meta.url);
const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
const wanted = {
  VALKEY_PASSWORD: () => randomBytes(24).toString('hex'),
  SESSION_PEPPER: () => randomBytes(32).toString('base64url'),
  SMTP_URL: () => 'smtp://127.0.0.1:1025',
  DATA_ENCRYPTION_KEY_ID: () => 'dev-1',
  DATA_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  MAIL_FROM: () => 'UniVarse <no-reply@univarse.localhost>',
  // Local S3-compatible store (SeaweedFS, ADR-025). tools/storage-dev.mjs writes its identity file.
  S3_ACCESS_KEY: () => `uvdev${randomBytes(8).toString('hex')}`,
  S3_SECRET_KEY: () => randomBytes(30).toString('base64url'),
};
const added = [];
let next = current.endsWith('\n') || current === '' ? current : current + '\n';
for (const [key, gen] of Object.entries(wanted)) {
  if (!new RegExp(`^${key}=`, 'm').test(current)) {
    next += `${key}=${gen()}\n`;
    added.push(key);
  }
}
// VALKEY_URL embeds the generated password.
const pw = (next.match(/^VALKEY_PASSWORD=(.*)$/m) ?? [])[1];
if (pw && !/^VALKEY_URL=/m.test(next)) {
  next += `VALKEY_URL=redis://:${pw}@127.0.0.1:6379\n`;
  added.push('VALKEY_URL');
}
writeFileSync(path, next, { mode: 0o600 });
console.log(added.length ? `Added to .env: ${added.join(', ')}` : '.env already has all dev secrets');
