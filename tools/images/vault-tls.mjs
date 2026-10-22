// Spec 0019 C1: where the production images reach the dev Vault (its TLS listener), and the dev CA they trust. No side
// effects on import (container.mjs loads .env; the release must not), so the release's precondition can use it too.
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

export const VAULT_TLS_ADDR = 'https://127.0.0.1:8201';
export const VAULT_CA = fileURLToPath(new URL('../../infra/compose/vault/tls/ca.crt', import.meta.url));

/**
 * Why the dev Vault can't serve the production images, or null: no dev CA; the TLS listener doesn't answer, or its
 * certificate doesn't verify against that CA for 127.0.0.1; or Vault is sealed or uninitialised (a sealed Vault
 * failed a release at its journeys, an hour in, on 2026-10-22). For a check before a long run.
 */
export function vaultTlsProblem({ caFile = VAULT_CA, addr = VAULT_TLS_ADDR } = {}) {
  if (!existsSync(caFile)) return Promise.resolve(`no dev Vault CA at ${caFile}: run pnpm dev:infra`);
  const ca = readFileSync(caFile);
  return new Promise((resolve) => {
    const req = httpsRequest(`${addr}/v1/sys/health`, { ca, timeout: 5000 }, (res) => {
      res.resume();
      // sys/health: 200 active and unsealed, 429 standby, 503 sealed, 501 not initialised.
      if (res.statusCode === 503) resolve('the dev Vault is sealed: run pnpm dev:vault');
      else if (res.statusCode === 501) resolve('the dev Vault is not initialised: run pnpm dev:infra');
      else resolve(null);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve(`the dev Vault's TLS listener (${addr}) failed: ${e.code ?? e.message}. Run pnpm dev:infra (spec 0019 C1)`));
    req.end();
  });
}
