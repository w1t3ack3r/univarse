/**
 * Spec 0039 Q4 (T37): how a process finds a shard's connection URL, for the app's role or the migrator's. Only names
 * come from the platform database; every URL comes from the environment, so a tampered `shard` row can reach no
 * database the deploy didn't give the process:
 *   • a pool: its own variable, `secret_ref` (`TENANT_POOL_01_DATABASE_URL`), or the migrator's twin
 *     (`TENANT_POOL_01_MIGRATOR_URL`);
 *   • a dedicated database: its server's URL template (`<server secret_ref>_APP_URL` or `_MIGRATOR_URL`, with
 *     `{database}` as the whole of its path), with the shard's database put in, only when that name is a dedicated
 *     database's (`univarse_t_` and 12 lower-case letters or digits).
 * Pure: the environment is passed in. Problems name variables and shards, never a value.
 */
export type ShardRole = 'app' | 'migrator';

export interface ShardAddress {
  readonly name: string;
  readonly kind: 'POOL' | 'DEDICATED';
  readonly secretRef: string;
  readonly database: string;
  readonly server: { readonly secretRef: string };
}

export const POOL_SECRET_REF = /^[A-Z0-9_]+_DATABASE_URL$/;
export const DEDICATED_DATABASE = /^univarse_t_[a-z0-9]{12}$/;
export const SERVER_SECRET_REF = /^DB_SERVER_[A-Z0-9_]{1,40}$/;
const PLACEHOLDER = '{database}';

export type ShardUrlProblem = 'invalid_secret_ref' | 'invalid_database' | 'no_credentials' | 'invalid_template';

/** The env variable a shard's URL comes from, for a role (for a dedicated database: its server's template). */
export function shardUrlVariable(s: ShardAddress, role: ShardRole): string | null {
  if (s.kind === 'POOL') {
    if (!POOL_SECRET_REF.test(s.secretRef)) return null;
    return role === 'app' ? s.secretRef : s.secretRef.replace(/_DATABASE_URL$/, '_MIGRATOR_URL');
  }
  if (!SERVER_SECRET_REF.test(s.server.secretRef)) return null;
  return `${s.server.secretRef}_${role === 'app' ? 'APP' : 'MIGRATOR'}_URL`;
}

export function shardUrl(
  s: ShardAddress,
  role: ShardRole,
  env: Readonly<Record<string, string | undefined>>,
): { readonly url: string } | { readonly problem: ShardUrlProblem } {
  const variable = shardUrlVariable(s, role);
  if (!variable) return { problem: 'invalid_secret_ref' };
  if (s.kind === 'POOL') {
    const url = env[variable];
    return url ? { url } : { problem: 'no_credentials' };
  }
  if (!DEDICATED_DATABASE.test(s.database)) return { problem: 'invalid_database' };
  const template = env[variable];
  if (!template) return { problem: 'no_credentials' };
  // The placeholder is the whole path, once: nothing else in the template (a host, a user, a query) can be steered.
  if (template.split(PLACEHOLDER).length !== 2) return { problem: 'invalid_template' };
  let parsed: URL;
  try {
    parsed = new URL(template.replace(PLACEHOLDER, s.database));
  } catch {
    return { problem: 'invalid_template' };
  }
  if (parsed.protocol !== 'postgresql:' || parsed.pathname !== `/${s.database}`) return { problem: 'invalid_template' };
  return { url: parsed.toString() };
}
