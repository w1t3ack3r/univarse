// Spec 0019 B4/LS9: where the E2E suite gets its settings. Against the dev chain (the default), from the root .env, as
// always. Against the stack (`pnpm stack:e2e` sets E2E_STACK=1), only from the environment the launcher builds from
// ~/.univarse/stack: the root .env is never read, and a missing setting stops the run before any test starts.
export const STACK_KEYS = ['E2E_DOMAIN', 'PLATFORM_DATABASE_URL', 'TENANT_POOL_01_DATABASE_URL', 'SESSION_PEPPER', 'MAILPIT_URL'] as const;

export interface E2eEnv {
  /** Running against the local production-like stack, over HTTPS. */
  readonly stack: boolean;
  /** A tenant's origin: the dev edge, or the stack's edge. */
  readonly origin: (slug: string) => string;
}

export function loadE2eEnv(env: Readonly<Record<string, string | undefined>>, loadRootEnv: () => void): E2eEnv {
  if (env.E2E_STACK === '1') {
    const missing = STACK_KEYS.filter((k) => !env[k]);
    if (missing.length) throw new Error(`the stack E2E run needs ${missing.join(', ')}: start it with pnpm stack:e2e (the root .env is never used)`);
    const domain = env.E2E_DOMAIN ?? '';
    return { stack: true, origin: (slug) => `https://${slug}.${domain}` };
  }
  loadRootEnv();
  return { stack: false, origin: (slug) => `http://${slug}.univarse.localhost:${String(Number(env.EDGE_PORT ?? 4180))}` };
}
