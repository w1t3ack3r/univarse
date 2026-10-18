// Spec 0016 IO12 (the shared maximum TTL) and IO17 (only the worker may hold the relay role's credentials).
import { readFileSync } from 'node:fs';
import { MAX_TENANT_CACHE_TTL_MS } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

// Placeholders shaped like real values; none is a credential (invariant 8).
const BASE = {
  PLATFORM_DATABASE_URL: 'postgresql://app@127.0.0.1:5432/platform',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  SESSION_PEPPER: 'x'.repeat(32),
};
const RELAY = { PLATFORM_RELAY_URL: 'postgresql://relay@127.0.0.1:5432/platform' };

describe('[IO12] the tenant cache TTL is capped by the shared maximum', () => {
  it('[IO12] a TTL above MAX_TENANT_CACHE_TTL_MS refuses to start, for the API and the worker; the maximum itself is accepted', () => {
    const over = { ...BASE, TENANT_CACHE_TTL_MS: String(MAX_TENANT_CACHE_TTL_MS + 1) };
    expect(() => loadConfig(over)).toThrow(/TENANT_CACHE_TTL_MS/);
    expect(() => loadConfig({ ...over, ...RELAY }, 'worker')).toThrow(/TENANT_CACHE_TTL_MS/);
    expect(
      loadConfig({ ...BASE, TENANT_CACHE_TTL_MS: String(MAX_TENANT_CACHE_TTL_MS) })
        .TENANT_CACHE_TTL_MS,
    ).toBe(60_000);
    expect(loadConfig(BASE).TENANT_CACHE_TTL_MS).toBe(30_000);
  });

  it("[IO12] the database knows the same maximum: the migration's cache_invalidation_max_ttl() equals the constant", () => {
    const sql = readFileSync(
      new URL(
        '../../../../packages/db/prisma/platform/migrations/20261018120000_cache_invalidation_outbox/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const m =
      /cache_invalidation_max_ttl\(\)[\s\S]*?AS \$\$ SELECT interval '(\d+) milliseconds' \$\$;/.exec(
        sql,
      );
    expect(m?.[1]).toBe(String(MAX_TENANT_CACHE_TTL_MS));
  });
});

describe('[IO17] only the worker may hold PLATFORM_RELAY_URL', () => {
  it('[IO17] the API refuses to start with PLATFORM_RELAY_URL set, without echoing its value', () => {
    let message = '';
    try {
      loadConfig({ ...BASE, ...RELAY });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/PLATFORM_RELAY_URL: set, but only the worker may hold the relay role/);
    expect(message).not.toContain(RELAY.PLATFORM_RELAY_URL);
    expect(loadConfig(BASE).PLATFORM_RELAY_URL).toBeUndefined();
  });

  it('[IO17] the worker accepts it', () => {
    expect(loadConfig({ ...BASE, ...RELAY }, 'worker').PLATFORM_RELAY_URL).toBe(
      RELAY.PLATFORM_RELAY_URL,
    );
  });
});
