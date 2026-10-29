import { BlockList, isIP } from 'node:net';
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
  if (!parsed.success || issues.length > 0) throw new Error(`Invalid platform API configuration:\n${issues.join('\n')}`);
  const config = parsed.data;
  return config.CONSOLE_ALLOWLIST.length > 0 ? config : { ...config, CONSOLE_ALLOWLIST: ['127.0.0.1', '::1'] };
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
