import { z } from 'zod';

// Boot-time config validation: the app refuses to start on invalid config (docs/02 §11).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PLATFORM_DATABASE_URL: z.string().startsWith('postgresql://'),
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
  TENANT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
  // Outbox worker poll interval (spec 0002 Part B).
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(2_000),
  /** Valkey/Redis for rate limiting (later: sessions cache, queues). */
  VALKEY_URL: z.string().startsWith('redis://'),
  /** Server-side secret mixed into one-time-code hashes so a DB leak can't brute-force 6-digit codes. */
  SESSION_PEPPER: z.string().min(32),
  /** Field-encryption key for secrets at rest (TOTP secrets). 32 bytes base64. ADR-018. */
  DATA_ENCRYPTION_KEY: z.string().min(40),
  DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9-]{1,32}$/),
  SMTP_URL: z.string().startsWith('smtp').default('smtp://127.0.0.1:1025'),
  MAIL_FROM: z.string().default('UniVarse <no-reply@univarse.localhost>'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
