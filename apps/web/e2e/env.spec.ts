// Spec 0019 B4/LS9: the stack run takes its settings only from the launcher's environment, never the root .env.
import { describe, expect, it } from 'vitest';
import { loadE2eEnv, STACK_KEYS } from './env.js';

const stackEnv = (): Record<string, string> => ({
  E2E_STACK: '1',
  E2E_DOMAIN: 'stack.univarse.localhost',
  PLATFORM_DATABASE_URL: 'postgresql://u:p@127.0.0.1:16432/univarse_platform?sslmode=verify-full',
  TENANT_POOL_01_DATABASE_URL: 'postgresql://u:p@127.0.0.1:16432/univarse_pool_01?sslmode=verify-full',
  SESSION_PEPPER: 'x'.repeat(43),
  MAILPIT_URL: 'https://mail.stack.univarse.localhost',
});

/** A loader that only counts how often the root .env would have been read. */
function counter(): { reads: number; load: () => void } {
  const c = {
    reads: 0,
    load: () => {
      c.reads++;
    },
  };
  return c;
}

describe('[LS9] the E2E settings (B4)', () => {
  it('[LS9] stack mode never reads the root .env, and serves the stack over HTTPS', () => {
    const root = counter();
    const e = loadE2eEnv(stackEnv(), root.load);
    expect(root.reads).toBe(0);
    expect(e.stack).toBe(true);
    expect(e.origin('demo-uni')).toBe('https://demo-uni.stack.univarse.localhost');
  });

  for (const key of STACK_KEYS)
    it(`[LS9] stack mode without ${key} refuses to start, and still doesn't fall back to the root .env`, () => {
      const root = counter();
      const env = Object.fromEntries(Object.entries(stackEnv()).filter(([k]) => k !== key));
      expect(() => loadE2eEnv(env, root.load)).toThrow(new RegExp(`needs ${key}.*pnpm stack:e2e`));
      expect(root.reads).toBe(0);
    });

  it('the dev chain (the default) reads the root .env, as before, on the dev edge', () => {
    const root = counter();
    const e = loadE2eEnv({}, root.load);
    expect(root.reads).toBe(1);
    expect(e.stack).toBe(false);
    expect(e.origin('demo-uni')).toBe('http://demo-uni.univarse.localhost:4180');
  });
});
