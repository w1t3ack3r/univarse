import { describe, expect, it } from 'vitest';
import { API_CONTROLLERS } from '../app.module.js';
import { allowlist, foreignCredentials, loadPlatformConfig } from './platform-config.js';
import { PLATFORM_CONTROLLERS } from './platform.module.js';

const OWN = { CONSOLE_DATABASE_URL: 'postgresql://univarse_console:x@127.0.0.1:5432/univarse_platform' };

describe('[P5] the platform API holds no tenant or app credential', () => {
  it('starts with its own URL alone, and defaults the allowlist to loopback outside production', () => {
    expect(loadPlatformConfig({ ...OWN, NODE_ENV: 'development' }).CONSOLE_ALLOWLIST).toEqual(['127.0.0.1', '::1']);
  });

  it('refuses every tenant or app credential, by name, never showing a value', () => {
    const env = {
      ...OWN,
      PLATFORM_DATABASE_URL: 'postgresql://secret-platform',
      TENANT_POOL_01_DATABASE_URL: 'postgresql://secret-tenant',
      PLATFORM_MIGRATOR_URL: 'postgresql://secret-migrator',
      PLATFORM_RELAY_URL: 'postgresql://secret-relay',
      SESSION_PEPPER: 'secret-pepper-secret-pepper-secret-pepper',
      VAULT_TOKEN: 'secret-token',
    };
    expect(foreignCredentials(env)).toEqual(['PLATFORM_DATABASE_URL', 'PLATFORM_MIGRATOR_URL', 'PLATFORM_RELAY_URL', 'SESSION_PEPPER', 'TENANT_POOL_01_DATABASE_URL', 'VAULT_TOKEN']);
    let message = '';
    try {
      loadPlatformConfig(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/TENANT_POOL_01_DATABASE_URL: set, but the platform API holds no tenant or app credential/);
    expect(message).not.toMatch(/secret/);
  });

  it('an empty variable is not a credential', () => {
    expect(foreignCredentials({ ...OWN, PLATFORM_DATABASE_URL: '' })).toEqual([]);
  });

  it('[P4] requires an allowlist in production', () => {
    expect(() => loadPlatformConfig({ ...OWN, NODE_ENV: 'production' })).toThrow(/CONSOLE_ALLOWLIST: required in production/);
    expect(loadPlatformConfig({ ...OWN, NODE_ENV: 'production', CONSOLE_ALLOWLIST: '172.31.218.1' }).CONSOLE_ALLOWLIST).toEqual(['172.31.218.1']);
  });
});

describe('[P4] the allowlist matcher', () => {
  const allowed = allowlist(['172.31.218.1', '10.0.0.0/8', '::1', 'fd00::/8']);

  it('matches single addresses, IPv4 subnets and IPv6 subnets', () => {
    expect(allowed('172.31.218.1')).toBe(true);
    expect(allowed('10.200.3.4')).toBe(true);
    expect(allowed('::1')).toBe(true);
    expect(allowed('fd12:3456::1')).toBe(true);
  });

  it('reads an IPv4 address mapped into IPv6 as the IPv4 address (Docker reports ::ffff:a.b.c.d)', () => {
    expect(allowed('::ffff:172.31.218.1')).toBe(true);
    expect(allowed('::ffff:172.31.218.2')).toBe(false);
  });

  it('refuses neighbours, other families and anything that isn\'t an address', () => {
    for (const ip of ['172.31.218.2', '11.0.0.1', '127.0.0.1', '::2', 'fe80::1', '', 'localhost', '172.31.218.1/32']) expect(allowed(ip)).toBe(false);
  });
});

describe('[P1] the tenant API and the platform API share no controller', () => {
  it('neither list holds the other\'s, and no tenant controller sits under /api/platform', () => {
    for (const c of PLATFORM_CONTROLLERS) expect(API_CONTROLLERS as readonly unknown[]).not.toContain(c);
    for (const c of API_CONTROLLERS) {
      const path = String(Reflect.getMetadata('path', c) ?? '');
      expect(path.replace(/^\/+/, '').startsWith('api/platform')).toBe(false);
    }
  });
});
