import { describe, expect, it } from 'vitest';
import { shardUrl, shardUrlVariable, type ShardAddress } from './shard-url.js';

const pool: ShardAddress = { name: 'pool-01', kind: 'POOL', secretRef: 'TENANT_POOL_01_DATABASE_URL', database: 'univarse_pool_01', server: { secretRef: 'DB_SERVER_LOCAL' } };
const dedicated: ShardAddress = { name: 't-abc', kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', database: 'univarse_t_abcdefgh1234', server: { secretRef: 'DB_SERVER_LOCAL' } };
const env = {
  TENANT_POOL_01_DATABASE_URL: 'postgresql://app:pw@pgbouncer:6432/univarse_pool_01',
  TENANT_POOL_01_MIGRATOR_URL: 'postgresql://migrator:pw@postgres:5432/univarse_pool_01?sslmode=verify-full',
  DB_SERVER_LOCAL_APP_URL: 'postgresql://app:pw@pgbouncer:6432/{database}?sslmode=verify-full',
  DB_SERVER_LOCAL_MIGRATOR_URL: 'postgresql://migrator:pw@postgres:5432/{database}?sslmode=verify-full&sslrootcert=/ca/ca.crt',
  UNUSED_DATABASE_URL: 'postgresql://app:pw@elsewhere:5432/other',
};

describe('a shard’s URL (spec 0039 Q4, T37)', () => {
  it('a pool: its own variable for the app, the migrator’s twin for the migrator', () => {
    expect(shardUrl(pool, 'app', env)).toEqual({ url: env.TENANT_POOL_01_DATABASE_URL });
    expect(shardUrl(pool, 'migrator', env)).toEqual({ url: env.TENANT_POOL_01_MIGRATOR_URL });
    expect(shardUrlVariable(pool, 'migrator')).toBe('TENANT_POOL_01_MIGRATOR_URL');
  });

  it('a dedicated database: its server’s template with its name as the whole path, never its own secret_ref', () => {
    expect(shardUrl(dedicated, 'app', env)).toEqual({ url: 'postgresql://app:pw@pgbouncer:6432/univarse_t_abcdefgh1234?sslmode=verify-full' });
    expect(shardUrl(dedicated, 'migrator', env)).toEqual({
      url: 'postgresql://migrator:pw@postgres:5432/univarse_t_abcdefgh1234?sslmode=verify-full&sslrootcert=/ca/ca.crt',
    });
  });

  it('refuses a name that isn’t a dedicated database’s, whatever a row says', () => {
    for (const database of ['univarse_platform', 'univarse_pool_01', 'univarse_t_ABCDEFGH1234', 'univarse_t_abc', 'univarse_t_abcdefgh1234x', 'univarse_t_abcdefgh123/x', 'postgres', '../univarse_platform'])
      expect(shardUrl({ ...dedicated, database }, 'app', env)).toEqual({ problem: 'invalid_database' });
  });

  it('refuses a variable name a row could point anywhere with', () => {
    expect(shardUrl({ ...pool, secretRef: 'SESSION_PEPPER' }, 'app', env)).toEqual({ problem: 'invalid_secret_ref' });
    expect(shardUrl({ ...pool, secretRef: 'tenant_pool_01_database_url' }, 'app', env)).toEqual({ problem: 'invalid_secret_ref' });
    expect(shardUrl({ ...dedicated, server: { secretRef: 'SESSION_PEPPER' } }, 'app', env)).toEqual({ problem: 'invalid_secret_ref' });
    expect(shardUrl({ ...dedicated, server: { secretRef: 'DB_SERVER_local' } }, 'app', env)).toEqual({ problem: 'invalid_secret_ref' });
  });

  it('says when the environment has no URL for it', () => {
    expect(shardUrl(pool, 'migrator', { TENANT_POOL_01_DATABASE_URL: 'x' })).toEqual({ problem: 'no_credentials' });
    expect(shardUrl(dedicated, 'app', {})).toEqual({ problem: 'no_credentials' });
  });

  it('refuses a template that could be steered: the placeholder missing, twice, or not the whole path', () => {
    for (const t of [
      'postgresql://app:pw@pgbouncer:6432/univarse_pool_01',
      'postgresql://app:pw@pgbouncer:6432/{database}?application_name={database}',
      'postgresql://app:pw@{database}:6432/x',
      'postgresql://app:pw@pgbouncer:6432/prefix_{database}',
      'mysql://app:pw@pgbouncer:6432/{database}',
    ])
      expect(shardUrl(dedicated, 'app', { DB_SERVER_LOCAL_APP_URL: t })).toEqual({ problem: 'invalid_template' });
  });
});
