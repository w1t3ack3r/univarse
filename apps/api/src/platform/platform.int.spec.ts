/**
 * Spec 0027 P1, P3, P4, P5: the platform API's walls and its role, against the real platform database.
 * Prereqs: `pnpm db:setup` (which writes .env.console) and `pnpm db:migrate`. Loads .env.console only, like platform.ts:
 * the platform API never sees the root .env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApp } from './platform-app.js';
import { loadPlatformConfig } from './platform-config.js';

const consoleEnvFile = new URL('../../../../.env.console', import.meta.url);
const CONSOLE_DATABASE_URL = existsSync(consoleEnvFile) ? parseEnv(readFileSync(consoleEnvFile, 'utf8')).CONSOLE_DATABASE_URL : undefined;
if (!CONSOLE_DATABASE_URL) throw new Error('No CONSOLE_DATABASE_URL in .env.console: run `pnpm db:setup`');

/** A route under the platform prefix, so the walls can be seen to let a request through (tests only). */
@Controller('api/platform/v1/test')
class WallProbeController {
  @Get('probe')
  probe() {
    return { reached: true };
  }
}

const EDGE = '172.31.219.10'; // Caddy, the trusted proxy
const GATEWAY = '172.31.218.1'; // the edge network's gateway: the owner, measured (spec 0027)
let app: NestFastifyApplication;
const get = (url: string, remoteAddress: string, forwardedFor?: string) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url, remoteAddress, headers: { host: 'console.stack.univarse.localhost', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) } });

beforeAll(async () => {
  const config = loadPlatformConfig({ NODE_ENV: 'test', CONSOLE_DATABASE_URL, TRUSTED_PROXIES: EDGE, CONSOLE_ALLOWLIST: GATEWAY });
  app = await createPlatformApp(config, { extraControllers: [WallProbeController] });
});
afterAll(async () => {
  await app.close();
});

describe('[P4] the allowlist, behind the edge', () => {
  it('lets the allowlisted address through the edge', async () => {
    const res = await get('/api/platform/v1/test/probe', EDGE, GATEWAY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reached: true });
  });

  it('refuses any other address with 404, exactly as an unknown route answers', async () => {
    const refused = await get('/api/platform/v1/test/probe', EDGE, '172.31.218.7');
    const unknown = await get('/api/platform/v1/no-such-route', EDGE, GATEWAY);
    expect(refused.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const shape = (r: typeof refused) => ({ ...(r.json<Record<string, unknown>>()), requestId: 'x' });
    expect(shape(refused)).toEqual(shape(unknown));
  });

  it('ignores a forwarded address from a peer that isn\'t the edge', async () => {
    expect((await get('/api/platform/v1/test/probe', '172.31.218.99', GATEWAY)).statusCode).toBe(404);
  });

  it('a forged address prepended by the client changes nothing: the right-most untrusted one counts', async () => {
    expect((await get('/api/platform/v1/test/probe', EDGE, `${GATEWAY}, 172.31.218.7`)).statusCode).toBe(404);
  });
});

describe('[P3] the platform API serves its prefix and health, nothing else', () => {
  it('a tenant path is 404 even from the allowlisted address', async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/tenant/public-profile', '/api/platform/v2/test/probe', '/', '/login']) {
      expect((await get(path, EDGE, GATEWAY)).statusCode, path).toBe(404);
    }
  });

  it('health answers on the container network, and ready means the platform database answers as the console role', async () => {
    expect((await get('/health/live', '172.31.219.20')).statusCode).toBe(200);
    expect((await get('/health/ready', '172.31.219.20')).json()).toEqual({ status: 'ready' });
  });
});

describe('[P5] the console role, in the database', () => {
  const as = (database: string) => createPlatformClient(CONSOLE_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${database}$1`));

  it('may connect to the platform database and to no other UniVarse database: every database, read from the catalogue', async () => {
    const db = as('univarse_platform');
    try {
      const rows = await db.$queryRaw<{ datname: string; connect: boolean }[]>`
        SELECT datname, has_database_privilege(current_user, datname, 'CONNECT') AS connect
          FROM pg_database WHERE NOT datistemplate AND datname LIKE 'univarse%' ORDER BY datname`;
      expect(rows.map((r) => r.datname)).toContain('univarse_pool_01'); // the scan sees the tenant databases
      expect(rows.filter((r) => r.connect).map((r) => r.datname)).toEqual(['univarse_platform']);
    } finally {
      await db.$disconnect();
    }
  });

  it('a real connection to the tenant database is refused', async () => {
    const tenant = as('univarse_pool_01');
    try {
      await expect(tenant.$queryRaw`SELECT 1`).rejects.toThrow(/permission denied for database|not have the CONNECT privilege/i);
    } finally {
      await tenant.$disconnect();
    }
  });

  it('holds no privilege on any platform table yet, and no special attribute: each later slice grants its own', async () => {
    const db = as('univarse_platform');
    try {
      const tables = await db.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
           AND (has_table_privilege(current_user, quote_ident(table_name), 'SELECT') OR has_table_privilege(current_user, quote_ident(table_name), 'INSERT')
             OR has_table_privilege(current_user, quote_ident(table_name), 'UPDATE') OR has_table_privilege(current_user, quote_ident(table_name), 'DELETE'))`;
      expect(tables).toEqual([]);
      const role = await db.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual([{ rolname: 'univarse_console', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }]);
    } finally {
      await db.$disconnect();
    }
  });
});
