import { BlockList, isIP } from 'node:net';
import { keyProviderFrom, vaultAddrProblem, type KeyProvider } from '@univarse/crypto';
import { z } from 'zod';

/**
 * Spec 0027 P1, P4, P5: the platform API's own configuration, separate from the tenant API's. It connects as
 * `univarse_console` to the platform database only, and holds no tenant credential: a process given one refuses to
 * start, so a misrendered env file can't hand the console a tenant database or the tenant API's secrets.
 */
const cidrList = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((list) => list.every((s) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s)), 'must be IPs or CIDRs');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UNIVARSE_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('dev'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  /** The console role's URL (spec 0027 P5): the platform database, as `univarse_console`. */
  CONSOLE_DATABASE_URL: z.string().startsWith('postgresql://'),
  /** Our edge proxies, as for the tenant API: forwarding headers are honoured only from these. */
  TRUSTED_PROXIES: cidrList,
  /**
   * Spec 0027 P4: the addresses allowed to reach `/api/platform/*`, checked again here after the edge. Anything else
   * gets 404, as an unknown route does. Required in production; development defaults to loopback.
   */
  CONSOLE_ALLOWLIST: cidrList,
  /**
   * Spec 0028 Q6: the console's own pepper for one-time and recovery codes (never the tenant API's SESSION_PEPPER,
   * which this process refuses). Required.
   */
  CONSOLE_CODE_PEPPER: z.string().min(32),
  /**
   * Spec 0028 Q3: staff TOTP secrets are encrypted with the console's own Transit key, through its own token, whose
   * policy allows that key only. `local` is for development and tests, and refused in production.
   */
  CONSOLE_KEY_PROVIDER: z.enum(['vault', 'local']).default('vault'),
  VAULT_ADDR: z.url().optional(),
  CONSOLE_VAULT_TOKEN: z.string().min(8).optional(),
  VAULT_TRANSIT_MOUNT: z.string().regex(/^[a-z0-9_-]{1,64}$/).default('transit'),
  CONSOLE_LOCAL_KEK: z.string().min(40).optional(),
  /** Spec 0028 Q4: the console's mail, sent by its own relay (Mailpit locally). */
  SMTP_URL: z.string().regex(/^smtps?:\/\//),
  MAIL_FROM: z.string().min(3).default('UniVarse Platform <no-reply@univarse.localhost>'),
  /** How often the relay looks for mail; 0 turns it off (tests drive it by hand). */
  MAIL_RELAY_INTERVAL_MS: z.coerce.number().int().min(0).default(2_000),
  /** Spec 0031 Q6: how often to see whether the daily chain verification is due; 0 turns it off (tests). */
  AUDIT_VERIFY_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
});

export type PlatformConfig = z.infer<typeof schema>;

/**
 * What the platform API must never hold: tenant and app database URLs (every `*_DATABASE_URL` but its own), the
 * relay's and the migrator's roles, and the tenant API's secrets. Checked by name, so a value is never read or shown.
 */
export function foreignCredentials(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== '')
    .filter(
      (k) =>
        (k.endsWith('_DATABASE_URL') && k !== 'CONSOLE_DATABASE_URL') ||
        k.endsWith('_MIGRATOR_URL') ||
        ['PLATFORM_RELAY_URL', 'SESSION_PEPPER', 'DATA_ENCRYPTION_KEY', 'VAULT_TOKEN', 'LOCAL_KEK', 'S3_SECRET_KEY', 'LEDGER_S3_SECRET_KEY'].includes(k),
    )
    .sort();
}

export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const parsed = schema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  for (const k of foreignCredentials(env)) issues.push(`  - ${k}: set, but the platform API holds no tenant or app credential (spec 0027 P5)`);
  if (parsed.success && parsed.data.NODE_ENV === 'production' && parsed.data.CONSOLE_ALLOWLIST.length === 0)
    issues.push('  - CONSOLE_ALLOWLIST: required in production (spec 0027 P4)');
  if (parsed.success) for (const p of consoleKeyProblems(parsed.data)) issues.push(`  - ${p}`);
  if (!parsed.success || issues.length > 0) throw new Error(`Invalid platform API configuration:\n${issues.join('\n')}`);
  const config = parsed.data;
  return config.CONSOLE_ALLOWLIST.length > 0 ? config : { ...config, CONSOLE_ALLOWLIST: ['127.0.0.1', '::1'] };
}

/** The console key's settings, checked at start (spec 0028 Q3), by name only. */
function consoleKeyProblems(c: z.infer<typeof schema>): string[] {
  if (c.CONSOLE_KEY_PROVIDER === 'local') {
    if (c.NODE_ENV === 'production') return ['CONSOLE_KEY_PROVIDER: local is refused in production (spec 0028 Q3)'];
    return c.CONSOLE_LOCAL_KEK ? [] : ['CONSOLE_LOCAL_KEK: required for CONSOLE_KEY_PROVIDER=local'];
  }
  const problems: string[] = [];
  if (!c.VAULT_ADDR) problems.push('VAULT_ADDR: required for the console key (spec 0028 Q3)');
  if (!c.CONSOLE_VAULT_TOKEN) problems.push('CONSOLE_VAULT_TOKEN: required for the console key (spec 0028 Q3)');
  const plain = vaultAddrProblem({ KEY_PROVIDER: 'vault', NODE_ENV: c.NODE_ENV, VAULT_ADDR: c.VAULT_ADDR });
  if (c.VAULT_ADDR && plain) problems.push(`VAULT_ADDR: ${plain}`);
  return problems;
}

/** The Transit key staff TOTP secrets are encrypted with (spec 0028 Q3): the console's own, never the tenant KEK. */
export const CONSOLE_KEK = 'univarse-console-kek';

/** The console key's provider: its own token and key, through the same factory and production rules as the API's. */
export function consoleKeyProvider(c: PlatformConfig): KeyProvider {
  return keyProviderFrom({
    KEY_PROVIDER: c.CONSOLE_KEY_PROVIDER,
    NODE_ENV: c.NODE_ENV,
    VAULT_ADDR: c.VAULT_ADDR,
    VAULT_TOKEN: c.CONSOLE_VAULT_TOKEN,
    VAULT_TRANSIT_MOUNT: c.VAULT_TRANSIT_MOUNT,
    VAULT_TRANSIT_KEY: CONSOLE_KEK,
    LOCAL_KEK: c.CONSOLE_LOCAL_KEK,
  });
}

/**
 * The allowlist as a matcher. Node's BlockList already matches an IPv4 address mapped into IPv6 (`::ffff:a.b.c.d`, as
 * Docker reports one) against the IPv4 entries; the tests hold that.
 */
export function allowlist(entries: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const e of entries) {
    const [address = '', bits] = e.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return (ip) => {
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}

export const PLATFORM_CONFIG = Symbol('PLATFORM_CONFIG');
/** The platform database, as `univarse_console` (spec 0027 P5). The platform API has no tenant client at all. */
export const CONSOLE_DB = Symbol('CONSOLE_DB');
