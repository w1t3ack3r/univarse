// Spec 0019 D9: `pnpm stack:init [--rotate]`. Creates the owner-only stack directory, its secrets (secrets.json)
// and the stack CA with its server certificates (certs/). Idempotent: what exists is kept unless --rotate. Prints
// what it made, never a value. The deploy renders env files and fills volumes from these at every run.
import { pathToFileURL } from 'node:url';
import { STACK_DIR } from './config.js';
import { ensureCerts } from './certs.js';
import { ensureStackDir, generateSecrets, saveSecrets } from './secrets.js';

export function init({ rotate = false } = {}): string[] {
  const done: string[] = [];
  ensureStackDir();
  done.push(`stack directory ${STACK_DIR} (owner-only)`);
  done.push(saveSecrets(generateSecrets(), { rotate }) ? 'secrets generated (secrets.json, owner-only)' : 'secrets kept (secrets.json exists; --rotate replaces them)');
  done.push(ensureCerts({ rotate }) ? 'stack CA and server certificates made (certs/)' : 'certificates kept (certs/ exists; --rotate replaces them)');
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rotate = process.argv.includes('--rotate');
  for (const line of init({ rotate })) console.log(`[stack:init] ${line}`);
  if (rotate) console.log('[stack:init] rotated: the next `pnpm stack:deploy` applies the new secrets everywhere');
}
