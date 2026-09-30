// Adds missing local-dev secrets (not DB — see `pnpm db:setup`) to the git-ignored root .env.
// Existing values are never overwritten.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../.env', import.meta.url);
const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
const wanted = {
  VALKEY_PASSWORD: () => randomBytes(24).toString('hex'),
  SESSION_PEPPER: () => randomBytes(32).toString('base64url'),
};
const added = [];
let next = current.endsWith('\n') || current === '' ? current : current + '\n';
for (const [key, gen] of Object.entries(wanted)) {
  if (!new RegExp(`^${key}=`, 'm').test(current)) {
    next += `${key}=${gen()}\n`;
    added.push(key);
  }
}
writeFileSync(path, next, { mode: 0o600 });
console.log(added.length ? `Added to .env: ${added.join(', ')}` : '.env already has all dev secrets');
