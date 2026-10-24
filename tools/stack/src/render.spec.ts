// Spec 0019: what each container is given (render.ts). LS5 (the database path through PgBouncer, TLS), LS9 (each
// secret only where it's needed), spec 0016 IO17 (the relay role in the worker's env only).
import { describe, expect, it } from 'vitest';
import { CADDY_IP, STACK_DOMAIN, WEB_IP } from './config.js';
import { envText, renderEnvFiles, renderPgBouncerIni, renderPgHba, renderS3Config, renderUserlist, renderValkeyConf } from './render.js';
import { generateSecrets, secretValues } from './secrets.js';

const s = generateSecrets();
const v = { appToken: 'hvs.test-app-token-0000000000' };
const files = renderEnvFiles(s, v);
const env = (name: string) => files[name] ?? {};
/** A URL with its password masked: a failing assertion prints what it compared. */
const masked = (u = '') => u.replace(/\/\/([^:/]+):[^@]+@/, '//$1:***@');

describe('[LS5] the database path', () => {
  it('[LS5] the API and worker reach PostgreSQL only through PgBouncer, verifying TLS (verify-full); the migrate job goes direct (PB8), with `require` for the Prisma schema engine', () => {
    for (const f of ['api.env', 'worker.env'])
      for (const k of ['PLATFORM_DATABASE_URL', 'TENANT_POOL_01_DATABASE_URL']) {
        expect([f, k, masked(env(f)[k])]).toEqual([f, k, expect.stringMatching(/^postgresql:\/\/\w+:\*\*\*@pgbouncer:6432\/univarse_\w+\?sslmode=verify-full$/)]);
      }
    for (const [k, val] of Object.entries(env('migrate.env')).filter(([key]) => key.endsWith('_URL')))
      expect([k, masked(val)]).toEqual([k, expect.stringMatching(/^postgresql:\/\/\w+:\*\*\*@postgres:5432\/\w+\?sslmode=require$/)]);
    for (const f of ['api.env', 'worker.env', 'migrate.env']) expect(env(f).NODE_EXTRA_CA_CERTS).toBe('/ca/ca.crt');
  });

  it('[LS5] PgBouncer requires TLS from clients and verifies PostgreSQL against the stack CA, in transaction pooling', () => {
    const ini = renderPgBouncerIni();
    for (const line of ['client_tls_sslmode = require', 'server_tls_sslmode = verify-full', 'server_tls_ca_file = /etc/pgbouncer/tls/ca.crt', 'pool_mode = transaction', 'auth_type = scram-sha-256'])
      expect(ini).toContain(line);
    expect(ini).toMatch(/univarse_platform = host=postgres port=5432 dbname=univarse_platform/);
  });

  it('[LS5] PostgreSQL accepts TLS connections only, SCRAM only: no plain host line, no trust', () => {
    const hba = renderPgHba().split('\n').filter((l) => l && !l.startsWith('#'));
    expect(hba.every((l) => /^(local|hostssl)\s/.test(l))).toBe(true);
    expect(hba.every((l) => l.trim().endsWith('scram-sha-256'))).toBe(true);
  });

  it('[LS5] the auth file holds the pooled roles\' SCRAM verifiers, the same the migrate job stores, and no password', () => {
    const list = renderUserlist(s);
    expect(list).toContain(`"univarse_app" "${s.verifiers.app}"`);
    expect(list).toContain(`"univarse_relay_platform" "${s.verifiers.relayPlatform}"`);
    expect(list).not.toContain('univarse_migrator'); // never pooled
    for (const pw of Object.values(s.roles)) expect(list).not.toContain(pw);
    expect(env('migrate.env').ROLE_VERIFIER_APP).toBe(s.verifiers.app);
  });
});

describe('[LS9] each secret only where it is needed', () => {
  it('[LS9] only the worker holds the relay role (spec 0016 IO17); the API refuses it at start anyway', () => {
    expect(env('worker.env').PLATFORM_RELAY_URL).toMatch(/^postgresql:\/\/univarse_relay_platform:/);
    for (const f of ['api.env', 'web.env', 'migrate.env']) expect([f, env(f).PLATFORM_RELAY_URL]).toEqual([f, undefined]);
  });

  it('[LS9] the web app holds no secret at all, and the superuser\'s password reaches only PostgreSQL and the migrate job', () => {
    const web = envText(env('web.env'));
    for (const value of secretValues(s)) expect(web).not.toContain(value);
    for (const f of ['api.env', 'worker.env', 'web.env']) expect(envText(env(f))).not.toContain(s.postgresSuperuser);
    expect(env('postgres.env')).toEqual({ POSTGRES_PASSWORD: s.postgresSuperuser });
  });

  it('[LS9] no role password reaches PgBouncer, and Valkey\'s config holds its own password only', () => {
    const conf = renderValkeyConf(s);
    expect(conf).toContain(`requirepass ${s.valkeyPassword}`);
    for (const pw of Object.values(s.roles)) expect(conf).not.toContain(pw);
  });

  it('[LS9] an env value with a newline is refused rather than written', () => {
    expect(() => envText({ A: 'x\ny' })).toThrow(/would break the env file/);
  });
});

describe('[B-3] the base backup', () => {
  it('[B-3] backup.env connects direct to PostgreSQL as the backup role, verify-full against the stack CA, and holds no other secret', () => {
    expect(env('backup.env')).toEqual({
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'univarse_backup',
      PGPASSWORD: s.backupPassword,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/ca/ca.crt',
      PGAPPNAME: 'univarse-backup',
    });
  });

  it('[B-3] the backup password reaches backup.env only; the migrate job gets its verifier', () => {
    for (const [f, e] of Object.entries(files)) if (f !== 'backup.env') expect([f, envText(e).includes(s.backupPassword)]).toEqual([f, false]);
    expect(env('migrate.env').ROLE_VERIFIER_BACKUP).toBe(s.backupVerifier);
    expect(secretValues(s)).toEqual(expect.arrayContaining([s.backupPassword, s.backupVerifier]));
  });

  it('[B-3] pg_hba allows replication for the backup role only, over TLS with SCRAM', () => {
    const hba = renderPgHba().split('\n').filter((l) => l && !l.startsWith('#'));
    const replication = hba.filter((l) => l.split(/\s+/)[1] === 'replication');
    expect(replication).toEqual(['hostssl replication univarse_backup 0.0.0.0/0 scram-sha-256']);
  });
});

describe('[A2-10] the object store\'s identities', () => {
  const identities = (JSON.parse(renderS3Config(s)) as { identities: { name: string; actions: string[] }[] }).identities;

  it('[A2-10] the shred ledger identity can put to its bucket, with the COMPLIANCE lock headers, and nothing else: no read, list, delete, legal hold or bypass', () => {
    // Exact: an added action fails this. Its puts working with the lock headers is bucket.int.ts's subject (real SeaweedFS).
    expect(identities.find((i) => i.name === 'univarse-shred-ledger')?.actions).toEqual(['Write:uv-shred-ledger', 'PutObjectRetention:uv-shred-ledger']);
  });

  it('[A2-10] exactly two identities: the app\'s and the ledger\'s', () => {
    expect(identities.map((i) => i.name)).toEqual(['univarse-app', 'univarse-shred-ledger']);
  });
});

describe('the edge and the containers', () => {
  it('the API and web listen inside their containers, and the API trusts forwarding only from Caddy and the web app', () => {
    expect(env('api.env')).toMatchObject({ HOST: '0.0.0.0', PORT: '8080', TRUSTED_PROXIES: `${CADDY_IP},${WEB_IP}`, NODE_ENV: 'production', KEY_PROVIDER: 'vault' });
    expect(env('web.env')).toMatchObject({ HOSTNAME: '0.0.0.0', PORT: '3000', API_INTERNAL_URL: 'http://api:8080' });
    expect(env('api.env').S3_PUBLIC_ENDPOINT).toBe(`https://files.${STACK_DOMAIN}`);
    expect(env('migrate.env').SEED_DOMAIN).toBe(STACK_DOMAIN);
    // LS8 (C2): every process that reaches Vault does so over TLS, verified against the stack CA.
    for (const f of ['api.env', 'worker.env', 'migrate.env']) expect([f, env(f).VAULT_ADDR, env(f).NODE_EXTRA_CA_CERTS]).toEqual([f, 'https://vault:8200', '/ca/ca.crt']);
  });
});
