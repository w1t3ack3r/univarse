// Spec 0019 D9/B2: `pnpm stack:init [--rotate] [--rotate-edge]`. Creates the owner-only stack directory, its secrets
// (secrets.json), the internal stack CA with its server certificates (certs/) and the name-constrained edge CA with
// Caddy's certificate (edge/). Idempotent: what exists is kept, an older set of internal certificates is reissued, and
// a secret added since is added alone. --rotate replaces the secrets and internal certificates; the edge CA, which the
// owner may have installed, changes only with --rotate-edge. Prints what it made, never a value.
import { pathToFileURL } from 'node:url';
import { STACK_DIR } from './config.js';
import { ensureCerts, ensureEdgeCerts } from './certs.js';
import { ensureStackDir, generateSecrets, saveSecrets } from './secrets.js';

const SECRETS = {
  written: 'secrets generated (secrets.json, owner-only)',
  kept: 'secrets kept (secrets.json exists; --rotate replaces them)',
  upgraded: "secrets kept, and PgBouncer's admin password added (secrets.json, owner-only)",
} as const;

export function init({ rotate = false, rotateEdge = false } = {}): string[] {
  const done: string[] = [];
  ensureStackDir();
  done.push(`stack directory ${STACK_DIR} (owner-only)`);
  done.push(SECRETS[saveSecrets(generateSecrets(), { rotate })]);
  done.push(ensureCerts({ rotate }) ? 'stack CA and server certificates made (certs/)' : 'certificates kept (certs/ is current; --rotate replaces them)');
  done.push(
    ensureEdgeCerts({ rotate: rotateEdge })
      ? 'edge CA (stack.univarse.localhost only) and Caddy\'s certificate made (edge/): run `pnpm stack:trust` to install it'
      : 'edge CA kept (edge/ exists; --rotate-edge replaces it, and then it must be installed again)',
  );
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rotate = process.argv.includes('--rotate');
  const rotateEdge = process.argv.includes('--rotate-edge');
  for (const line of init({ rotate, rotateEdge })) console.log(`[stack:init] ${line}`);
  if (rotate || rotateEdge) console.log('[stack:init] rotated: the next `pnpm stack:deploy` applies the new secrets and certificates everywhere');
}
