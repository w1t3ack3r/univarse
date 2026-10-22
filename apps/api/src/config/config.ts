import { MAX_TENANT_CACHE_TTL_MS } from '@univarse/contracts';
import { graceProblem, RETIRED_KEY_GRACE_MS } from '@univarse/crypto';
import { z } from 'zod';

// Boot-time config validation: the app refuses to start on invalid config (docs/02 §11).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Spec 0012: Pino level. Tests are silent unless a test captures lines. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** The build's git SHA, stamped into every log line (`version`); `dev` locally. */
  UNIVARSE_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('dev'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PLATFORM_DATABASE_URL: z.string().startsWith('postgresql://'),
  /**
   * Spec 0016 IO17: the platform invalidation relay's own role, for the WORKER only. db:setup writes it to the
   * git-ignored .env.worker (never the root .env, which the API's development preload loads); every other process
   * refuses to start with it set (loadConfig).
   */
  PLATFORM_RELAY_URL: z.string().startsWith('postgresql://').optional(),
  /**
   * Comma-separated IPs/CIDRs of OUR edge proxies. X-Forwarded-For/-Host are honoured only when the
   * TCP peer is in this list; the client IP is then the right-most address not in it, so a client
   * prepending forged addresses changes nothing. Empty (default) ⇒ forwarding headers are ignored.
   * Never use a blanket "trust all" (docs/08 §3.4).
   */
  TRUSTED_PROXIES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .refine((list) => list.every((s) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s)), 'must be IPs or CIDRs'),
  /** How long a resolved host→tenant mapping is cached in memory. */
  // Spec 0016 D6: capped by the shared maximum, which the database's expiry bound also uses.
  TENANT_CACHE_TTL_MS: z.coerce.number().int().min(0).max(MAX_TENANT_CACHE_TTL_MS).default(30_000),
  // Outbox worker poll interval (spec 0002 Part B).
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(2_000),
  /** Valkey/Redis for rate limiting (later: sessions cache, queues). */
  VALKEY_URL: z.string().startsWith('redis://'),
  /** Server-side secret mixed into one-time-code hashes so a DB leak can't brute-force 6-digit codes. */
  SESSION_PEPPER: z.string().min(32),
  /**
   * Legacy single field key (ADR-018). Since spec 0006 it only DECRYPTS existing v1 values until the
   * v1 → v2 migration (E9) completes; a later release removes it (expand → migrate → contract).
   */
  DATA_ENCRYPTION_KEY: z.string().min(40).optional(),
  DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
  /**
   * Envelope encryption (spec 0006, ADR-023): per-tenant DEKs wrapped by a KEK in Vault Transit.
   * `local` is an in-process KEK for unit tests only and is refused in production.
   */
  KEY_PROVIDER: z.enum(['vault', 'local']).default('vault'),
  VAULT_ADDR: z.url().optional(),
  VAULT_TOKEN: z.string().min(8).optional(),
  VAULT_TRANSIT_MOUNT: z.string().regex(/^[a-z0-9_-]{1,64}$/).default('transit'),
  VAULT_TRANSIT_KEY: z.string().regex(/^[a-z0-9_-]{1,64}$/).default('univarse-kek'),
  LOCAL_KEK: z.string().min(40).optional(),
  /** Unwrapped-DEK cache TTL (≤ 1 h, docs/07 §8). */
  DEK_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(3_600_000),
  /** Settings cache TTL: the worst-case staleness if an invalidation is lost (spec 0007 D2, ≤ 30 s). 0 = no cache. */
  SETTINGS_CACHE_TTL_MS: z.coerce.number().int().min(0).max(30_000).default(30_000),
  /** How often the worker looks for a pending key sweep (spec 0006 E7, E9). */
  KEY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** Spec 0020 D15's `G`: how long a retired key version is kept before it may be destroyed (≥ the writer bound + 60 s). */
  RETIRED_KEY_GRACE_MS: z.coerce
    .number()
    .int()
    .default(RETIRED_KEY_GRACE_MS)
    .superRefine((v, ctx) => {
      const problem = graceProblem(v);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  /**
   * Spec 0020 D14: the operation id of the destruction job this process runs as. Only the host protocol's one-shot
   * job sets it; in production a key destruction for any other op is refused.
   */
  UNIVARSE_DESTRUCTION_OP: z.uuid().optional(),
  /** Spec 0020 A2-10: the shred-ledger bucket's own identity (the keys job only); never the app's S3 identity. */
  LEDGER_S3_ACCESS_KEY: z.string().min(8).optional(),
  LEDGER_S3_SECRET_KEY: z.string().min(16).optional(),
  // Files (spec 0010). S3-compatible storage (SeaweedFS locally, ADR-025) and clamd.
  S3_ENDPOINT: z.url().default('http://127.0.0.1:8333'),
  /** The origin browsers upload to (presigned POST, D1). Same as S3_ENDPOINT locally. */
  S3_PUBLIC_ENDPOINT: z.url().default('http://127.0.0.1:8333'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(8).optional(),
  S3_SECRET_KEY: z.string().min(16).optional(),
  S3_QUARANTINE_BUCKET: z.string().regex(/^[a-z0-9-]{3,63}$/).default('uv-quarantine'),
  S3_CLEAN_BUCKET: z.string().regex(/^[a-z0-9-]{3,63}$/).default('uv-clean'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** Per-scan timeout; a timeout is retried, never treated as clean (FU3). */
  CLAMD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  FILE_SCAN_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
  SMTP_URL: z.string().startsWith('smtp').default('smtp://127.0.0.1:1025'),
  MAIL_FROM: z.string().default('UniVarse <no-reply@univarse.localhost>'),
});

export type AppConfig = z.infer<typeof schema>;

/**
 * Validates the environment for one kind of process. Only the worker may hold the relay's credentials
 * (spec 0016 IO17): any other process with PLATFORM_RELAY_URL set refuses to start.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  kind: 'api' | 'worker' = 'api',
): AppConfig {
  const parsed = schema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  if (kind !== 'worker' && env.PLATFORM_RELAY_URL !== undefined)
    issues.push('  - PLATFORM_RELAY_URL: set, but only the worker may hold the relay role (spec 0016 IO17); it belongs in .env.worker');
  if (!parsed.success || issues.length > 0) throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
