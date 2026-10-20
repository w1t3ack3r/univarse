// Spec 0019: what each container is given, rendered from the owner-only secrets (`stack:init`) and Vault's tokens
// (`stack:vault`). Pure, so the content is unit-tested; the deploy writes the results into STACK_DIR, owner-only,
// right before it starts anything. Nothing here is ever printed.
import { renderAuthFile } from '../../../packages/db/scripts/pgbouncer-config.js';
import { CADDY_IP, STACK_DOMAIN } from './config.js';

export interface StackSecrets {
  readonly postgresSuperuser: string;
  readonly roles: Readonly<Record<'migrator' | 'app' | 'appPlatform' | 'relayPlatform', string>>;
  /** SCRAM-SHA-256 verifiers of the role passwords: what PostgreSQL and PgBouncer store (spec 0017 PB9). */
  readonly verifiers: Readonly<Record<'migrator' | 'app' | 'appPlatform' | 'relayPlatform', string>>;
  readonly pgbouncerAdminVerifier: string;
  readonly sessionPepper: string;
  readonly valkeyPassword: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
}

export interface VaultTokens {
  /** Least privilege: encrypt and decrypt with the KEK only (spec 0006). */
  readonly appToken: string;
}

export type EnvFile = Readonly<Record<string, string>>;

const PG = 'postgres:5432';
const BOUNCER = 'pgbouncer:6432';
const enc = encodeURIComponent;
/**
 * Every database connection verifies its server against the stack CA (D7). The API and worker connect with
 * node-postgres, so they say `verify-full`. The migrate job's URLs are also read by Prisma's schema engine, which
 * accepts `require` (encrypted, not verified); node-postgres treats `require` as verify-full until its next major
 * version, so the job's own pg connections stay verified. That limit is stated in spec 0019's notes.
 */
const url = (user: string, password: string, at: string, db: string, sslmode: 'verify-full' | 'require' = 'verify-full') =>
  `postgresql://${user}:${enc(password)}@${at}/${db}?sslmode=${sslmode}`;

/** The settings every API and worker process shares. */
function appCommon(s: StackSecrets, v: VaultTokens): EnvFile {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    // The stack CA, for PgBouncer's and (PR C) Vault's certificates.
    NODE_EXTRA_CA_CERTS: '/ca/ca.crt',
    PLATFORM_DATABASE_URL: url('univarse_app_platform', s.roles.appPlatform, BOUNCER, 'univarse_platform'),
    TENANT_POOL_01_DATABASE_URL: url('univarse_app', s.roles.app, BOUNCER, 'univarse_pool_01'),
    VALKEY_URL: `redis://:${enc(s.valkeyPassword)}@valkey:6379`,
    SESSION_PEPPER: s.sessionPepper,
    KEY_PROVIDER: 'vault',
    VAULT_ADDR: 'http://vault:8200',
    VAULT_TOKEN: v.appToken,
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_PUBLIC_ENDPOINT: `http://files.${STACK_DOMAIN}`,
    S3_ACCESS_KEY: s.s3AccessKey,
    S3_SECRET_KEY: s.s3SecretKey,
    SMTP_URL: 'smtp://mailpit:1025',
    MAIL_FROM: `UniVarse <no-reply@${STACK_DOMAIN}>`,
    CLAMD_HOST: 'clamav',
  };
}

export function renderEnvFiles(s: StackSecrets, v: VaultTokens): Readonly<Record<string, EnvFile>> {
  const common = appCommon(s, v);
  return {
    'postgres.env': { POSTGRES_PASSWORD: s.postgresSuperuser },
    'api.env': {
      ...common,
      // Bind inside the container (the default 127.0.0.1 would be unreachable); trust forwarding only from Caddy.
      HOST: '0.0.0.0',
      PORT: '8080',
      TRUSTED_PROXIES: CADDY_IP,
    },
    // Only the worker holds the relay role (spec 0016 IO17), through its own PgBouncer pool.
    'worker.env': {
      ...common,
      PLATFORM_RELAY_URL: url('univarse_relay_platform', s.roles.relayPlatform, BOUNCER, 'univarse_platform'),
    },
    'web.env': {
      NODE_ENV: 'production',
      HOSTNAME: '0.0.0.0',
      PORT: '3000',
      API_INTERNAL_URL: 'http://api:8080',
      STORAGE_UPLOAD_ORIGIN: `http://files.${STACK_DOMAIN}`,
    },
    // LS4: direct to PostgreSQL (PB8), as the superuser for the bootstrap and the roles after it.
    'migrate.env': {
      NODE_ENV: 'production',
      NODE_EXTRA_CA_CERTS: '/ca/ca.crt',
      BOOTSTRAP_SUPERUSER_URL: url('postgres', s.postgresSuperuser, PG, 'postgres', 'require'),
      ROLE_VERIFIER_MIGRATOR: s.verifiers.migrator,
      ROLE_VERIFIER_APP: s.verifiers.app,
      ROLE_VERIFIER_APP_PLATFORM: s.verifiers.appPlatform,
      ROLE_VERIFIER_RELAY_PLATFORM: s.verifiers.relayPlatform,
      PLATFORM_MIGRATOR_URL: url('univarse_migrator', s.roles.migrator, PG, 'univarse_platform', 'require'),
      TENANT_POOL_01_MIGRATOR_URL: url('univarse_migrator', s.roles.migrator, PG, 'univarse_pool_01', 'require'),
      PLATFORM_DATABASE_URL: url('univarse_app_platform', s.roles.appPlatform, PG, 'univarse_platform', 'require'),
      TENANT_POOL_01_DATABASE_URL: url('univarse_app', s.roles.app, PG, 'univarse_pool_01', 'require'),
      SEED_DOMAIN: STACK_DOMAIN,
      KEY_PROVIDER: 'vault',
      VAULT_ADDR: 'http://vault:8200',
      VAULT_TOKEN: v.appToken,
    },
  };
}

/**
 * `KEY=value` lines for compose's env_file. Compose interpolates `$` in env files, so every `$` is written `$$`
 * (a SCRAM verifier is full of them: unescaped, compose blanked parts of it and logged them as variable names).
 * Values are generated (hex, base64url, SCRAM) or fixed: none holds a newline.
 */
export function envText(file: EnvFile): string {
  for (const [k, val] of Object.entries(file)) if (/[\r\n]/.test(val)) throw new Error(`${k} would break the env file`);
  return `${Object.entries(file).map(([k, val]) => `${k}=${val.replaceAll('$', '$$$$')}`).join('\n')}\n`;
}

/** PgBouncer for the stack (D7): TLS required from clients, the server verified against the stack CA. */
export function renderPgBouncerIni(): string {
  return [
    '; Generated by pnpm stack:deploy (spec 0019). The stack only.',
    '[databases]',
    ...['univarse_platform', 'univarse_pool_01'].map((d) => `${d} = host=postgres port=5432 dbname=${d}`),
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'unix_socket_dir =',
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'admin_users = pgbouncer_admin',
    'pool_mode = transaction',
    'default_pool_size = 10',
    'max_client_conn = 200',
    'max_prepared_statements = 0',
    'query_wait_timeout = 2',
    'server_round_robin = 0',
    // LS5: a plaintext client is refused; PgBouncer proves itself with the stack CA's certificate.
    'client_tls_sslmode = require',
    'client_tls_key_file = /etc/pgbouncer/tls/server.key',
    'client_tls_cert_file = /etc/pgbouncer/tls/server.crt',
    'client_tls_ca_file = /etc/pgbouncer/tls/ca.crt',
    // ...and it verifies PostgreSQL's certificate and name against the same CA.
    'server_tls_sslmode = verify-full',
    'server_tls_ca_file = /etc/pgbouncer/tls/ca.crt',
    '',
  ].join('\n');
}

export function renderValkeyConf(s: StackSecrets): string {
  return ['# Generated by pnpm stack:deploy (spec 0019).', 'bind 0.0.0.0', 'port 6379', `requirepass ${s.valkeyPassword}`, 'save ""', 'appendonly no', ''].join('\n');
}

export function renderS3Config(s: StackSecrets): string {
  return `${JSON.stringify(
    {
      identities: [
        {
          name: 'univarse-app',
          credentials: [{ accessKey: s.s3AccessKey, secretKey: s.s3SecretKey }],
          actions: ['Read', 'Write', 'List', 'Tagging', 'Admin'],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/**
 * LS5: PostgreSQL accepts TLS connections only, SCRAM only. The local socket (the image's first-start setup) needs
 * the superuser's password too; there is no trust line anywhere.
 */
export function renderPgHba(): string {
  return [
    '# Generated by pnpm stack:deploy (spec 0019). TYPE DATABASE USER ADDRESS METHOD',
    'local   all all             scram-sha-256',
    'hostssl all all 0.0.0.0/0   scram-sha-256',
    'hostssl all all ::/0        scram-sha-256',
    '',
  ].join('\n');
}

/** PgBouncer's auth file: the pooled roles' verifiers (the same ones the migrate job stores in PostgreSQL), and the admin's. */
export function renderUserlist(s: StackSecrets): string {
  return renderAuthFile([
    { user: 'univarse_app', verifier: s.verifiers.app },
    { user: 'univarse_app_platform', verifier: s.verifiers.appPlatform },
    { user: 'univarse_relay_platform', verifier: s.verifiers.relayPlatform },
    { user: 'pgbouncer_admin', verifier: s.pgbouncerAdminVerifier },
  ]);
}
