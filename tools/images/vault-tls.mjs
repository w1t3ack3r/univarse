// Spec 0019 C1: where the production images reach the dev Vault (its TLS listener), and the dev CA they trust. No side
// effects on import (container.mjs loads .env; the release must not), so the release's precondition can use it too.
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

export const VAULT_TLS_ADDR = 'https://127.0.0.1:8201';
export const VAULT_CA = fileURLToPath(new URL('../../infra/compose/vault/tls/ca.crt', import.meta.url));

/**
 * Why the dev Vault's TLS listener can't serve the production images, or null: no dev CA, or the listener doesn't
 * answer, or its certificate doesn't verify against that CA for 127.0.0.1. For a check before a long run.
 */
export function vaultTlsProblem({ caFile = VAULT_CA, addr = VAULT_TLS_ADDR } = {}) {
  if (!existsSync(caFile)) return Promise.resolve(`no dev Vault CA at ${caFile}: run pnpm dev:infra`);
  const ca = readFileSync(caFile);
  return new Promise((resolve) => {
    const req = httpsRequest(`${addr}/v1/sys/health`, { ca, timeout: 5000 }, (res) => {
      res.resume();
      resolve(null); // any HTTP answer (sealed included) over a verified TLS connection
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve(`the dev Vault's TLS listener (${addr}) failed: ${e.code ?? e.message}. Run pnpm dev:infra (spec 0019 C1)`));
    req.end();
  });
}
