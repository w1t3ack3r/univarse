// Spec 0019: the stack's fixed facts. Trusted code: the deploy and the static checks read these, never a record.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** D9: every generated secret, key, certificate and env file lives here, owner-only, outside the repository. */
export const STACK_DIR = process.env.UNIVARSE_STACK_DIR ?? join(homedir(), '.univarse', 'stack');
/** D6: the stack's own hostnames, so its HSTS never touches the development names. */
export const STACK_DOMAIN = 'stack.univarse.localhost';
/** The repository root: scripts run from tools/stack (pnpm --filter), so every path is anchored here. */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const COMPOSE_FILE = join(REPO, 'infra', 'stack', 'compose.yml');
export const RELEASES = join(REPO, 'releases');
export const PROJECT = 'univarse-stack';

/**
 * D8: third-party images, pinned by digest (the deploy scans and reports them; ADR-029 D4 governs only the images
 * UniVarse builds). Versions are the tags each digest was resolved from on 2026-10-19.
 */
export const THIRD_PARTY = Object.freeze({
  postgres: 'postgres:18@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336',
  valkey: 'valkey/valkey:8-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507',
  seaweedfs: 'chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d',
  mailpit: 'axllent/mailpit:v1.27@sha256:e22dce5b36f93c77082e204a3942fb6b283b7896e057458400a4c88344c3df68',
  vault: 'hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2',
  clamav: 'clamav/clamav:stable@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0',
  caddy: 'caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af',
});

/** The compose variables the verified record fills, per release role (LS2: the compose file names no UniVarse image). */
export const ROLE_VARS = Object.freeze({
  api: 'UNIVARSE_API_IMAGE',
  web: 'UNIVARSE_WEB_IMAGE',
  migrate: 'UNIVARSE_MIGRATE_IMAGE',
  pgbouncer: 'UNIVARSE_PGBOUNCER_IMAGE',
});
export type Role = keyof typeof ROLE_VARS;

/** The `app` network's fixed address plan: the API trusts forwarding headers only from Caddy's address (docs/08 §3.4). */
export const APP_SUBNET = '172.31.219.0/24';
export const CADDY_IP = '172.31.219.10';

/** D10: the sum of the long-running containers' memory limits, without ClamAV (a profile), must stay within this. */
export const MEMORY_BUDGET_MB = 3584;

const DIGEST_REF = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
/** LS2: an image reference the stack may run: a repository pinned by digest (a tag alone never). */
export const isDigestRef = (ref: string): boolean => DIGEST_REF.test(ref);
