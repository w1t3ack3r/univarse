import { z } from 'zod';

// Boot-time config validation: the app refuses to start on invalid config (docs/02 §11).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PLATFORM_DATABASE_URL: z.string().startsWith('postgresql://'),
  /** Only trust X-Forwarded-* when running behind our edge proxy. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** How long a resolved host→tenant mapping is cached in memory. */
  TENANT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
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
